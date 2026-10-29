-- Fail closed on downgrade if real reviewed metadata exists; never
-- silently destroy user-approved policy/provenance/assessments.
BEGIN;
DO $guard$
BEGIN
 IF EXISTS(SELECT 1 FROM vns.feed_ranking_policy_reviews)
 OR EXISTS(SELECT 1 FROM vns.feed_publisher_provenance_reviews)
 OR EXISTS(SELECT 1 FROM vns.feed_event_factor_reviews)
 THEN RAISE EXCEPTION 'Cannot discard reviewed weighted ranking evidence'
   USING ERRCODE='55000'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION vns.refresh_approved_feed_rankings(
  p_source text,p_limit integer
) RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $body$
DECLARE v_count integer;
BEGIN
  IF p_source IS NULL OR p_source !~ '^[a-z][a-z0-9_-]{2,40}$'
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
  THEN
    RAISE EXCEPTION 'Approved feed rank request invalid' USING ERRCODE='22023';
  END IF;
  WITH registry AS (
    SELECT sources FROM vns.admin_source_registry WHERE singleton=true
  ), profiles AS (
    SELECT r.revision,p.value AS profile
    FROM vns.editorial_profile_registry r
    CROSS JOIN LATERAL jsonb_array_elements(r.profiles) p
    WHERE r.singleton=true
  ), candidates AS (
    SELECT e.event_id,e.label,e.event_fingerprint,p.revision,
           p.profile,p.profile->>'id' AS profile_id,
           s.article_count,s.source_count,s.oldest_at,s.newest_at,
           k.matches,
           vns.rank_nfkc_words(e.label) AS normalized_title
    FROM vns.research_events e
    CROSS JOIN profiles p
    CROSS JOIN LATERAL (
      SELECT count(*)::integer AS article_count,
             count(DISTINCT a.source_key)::integer AS source_count,
             min(a.published_at) AS oldest_at,max(a.published_at) AS newest_at
      FROM vns.research_event_articles ea
      JOIN vns.research_articles a ON a.article_id=ea.article_id
      WHERE ea.event_id=e.event_id
    ) s
    CROSS JOIN LATERAL (
      SELECT count(*)::integer AS matches
      FROM jsonb_array_elements_text(p.profile->'keywords') term(value)
      WHERE (' '||vns.rank_nfkc_words(e.label)||' ')
        LIKE ('% '||vns.rank_nfkc_words(term.value)||' %')
    ) k
    WHERE EXISTS (
      SELECT 1 FROM vns.research_event_articles ea
      JOIN vns.research_articles a ON a.article_id=ea.article_id
      WHERE ea.event_id=e.event_id AND a.source_key=p_source
    )
    AND s.article_count BETWEEN 1 AND 100
    AND s.source_count >= (p.profile->>'minIndependentSources')::integer
    AND s.oldest_at >= clock_timestamp() -
      ((p.profile->>'maximumArticleAgeHours')::integer * interval '1 hour')
    AND s.newest_at <= clock_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(p.profile->'blockedTerms') term(value)
      WHERE (' '||vns.rank_nfkc_words(e.label)||' ')
        LIKE ('% '||vns.rank_nfkc_words(term.value)||' %')
    )
    AND NOT EXISTS (
      SELECT 1 FROM vns.research_event_articles ea
      JOIN vns.research_articles a ON a.article_id=ea.article_id
      WHERE ea.event_id=e.event_id
        AND NOT EXISTS (
          SELECT 1 FROM registry r
          CROSS JOIN LATERAL jsonb_array_elements(r.sources) src(value)
          WHERE src.value->>'id'=a.source_key
            AND vns.feed_runtime_source_authorized(src.value)
        )
    )
  )
  INSERT INTO vns.feed_event_rankings (
    event_id,profile_id,profile_revision,score,article_count,
    source_count,reasons,approved_for_publication
  )
  SELECT c.event_id,c.profile_id,c.revision,
    least(1000, c.matches*10 + c.source_count*3 +
      greatest(0,floor((c.profile->>'maximumArticleAgeHours')::integer -
      extract(epoch from (clock_timestamp()-c.newest_at))/3600)::integer)),
    c.article_count,c.source_count,
    jsonb_build_array(
      'metadata_candidate_only',
      'independent_verification_required',
      'keyword_matches:'||c.matches::text,
      'distinct_source_ids:'||c.source_count::text
    ),false
  FROM candidates c
  ORDER BY c.event_id,c.profile_id LIMIT p_limit
  ON CONFLICT(event_id,profile_id,profile_revision) DO UPDATE
  SET score=EXCLUDED.score,
      article_count=EXCLUDED.article_count,
      source_count=EXCLUDED.source_count,
      reasons=EXCLUDED.reasons,
      ranked_at=clock_timestamp();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$body$;
CREATE OR REPLACE FUNCTION vns.named_ranked_feed_page(p_limit integer)
RETURNS TABLE(
  event_id uuid,profile_id text,profile_revision bigint,headline text,
  score integer,article_count integer,source_count integer,
  reasons jsonb,ranked_at timestamptz,approved_for_publication boolean
) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vns.editor_db_principals p
    JOIN vns.editor_accounts a ON a.id=p.editor_id
    WHERE p.login_role=session_user AND p.active=true AND a.active=true
      AND a.auth_version=p.auth_version AND a.role='admin'
  ) THEN
    RAISE EXCEPTION 'Named ranked feed reader forbidden' USING ERRCODE='42501';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Ranked feed page bound invalid' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT r.event_id,r.profile_id,r.profile_revision,e.label,
    r.score,r.article_count,r.source_count,r.reasons,r.ranked_at,
    r.approved_for_publication
  FROM vns.feed_event_rankings r
  JOIN vns.research_events e ON e.event_id=r.event_id
  JOIN vns.editorial_profile_registry p ON p.singleton=true
    AND p.revision=r.profile_revision
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(p.profiles) prof(value)
    WHERE prof.value->>'id'=r.profile_id
  )
  -- A stored score is historical. Reject any event whose oldest article
  -- has aged out under the CURRENT profile; never revive an outdated story
  -- merely because a second copy was published later.
  AND NOT EXISTS (
    SELECT 1 FROM vns.research_event_articles ea
    JOIN vns.research_articles a ON a.article_id=ea.article_id
    JOIN LATERAL (
      SELECT prof.value AS profile
      FROM jsonb_array_elements(p.profiles) prof(value)
      WHERE prof.value->>'id'=r.profile_id
    ) current_profile ON true
    WHERE ea.event_id=r.event_id AND
      (a.published_at IS NULL OR
       a.published_at>clock_timestamp() OR
       a.published_at<clock_timestamp()-
         ((current_profile.profile->>'maximumArticleAgeHours')::integer * interval '1 hour'))
  )
  AND NOT EXISTS (
    SELECT 1 FROM vns.research_event_articles ea
    JOIN vns.research_articles a ON a.article_id=ea.article_id
    WHERE ea.event_id=r.event_id AND NOT EXISTS (
      SELECT 1 FROM vns.admin_source_registry s
      CROSS JOIN LATERAL jsonb_array_elements(s.sources) src(value)
      WHERE s.singleton=true AND src.value->>'id'=a.source_key
        AND vns.feed_runtime_source_authorized(src.value)
    )
  )
  ORDER BY r.score DESC,r.ranked_at DESC,r.event_id
  LIMIT p_limit;
END;
$body$;
DROP FUNCTION vns.reviewed_feed_weighted_score(uuid,text,bigint,integer,integer,timestamptz);
ALTER TABLE vns.feed_event_rankings DROP COLUMN policy_revision;
DROP TABLE vns.feed_event_factor_reviews;
DROP TABLE vns.feed_publisher_provenance_reviews;
DROP TABLE vns.feed_ranking_policy_reviews;
DROP FUNCTION vns.guard_immutable_feed_rank_review();
DELETE FROM vns.schema_migrations WHERE version='0053_reviewed_weighted_rankings';
COMMIT;
