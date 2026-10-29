-- P2-04 0053: optional reviewed weighted metadata ranking, fail closed.
-- No feed supplied publisher quality, no inferred explanation/visual factors.
-- DBA-owned immutable reviews require independently approved operator input;
-- merely merging this migration does NOT create those reviews.
BEGIN;
-- All reviewed ranking metadata is DBA-custodied and append-only.
-- Feed workers, ordinary API users and even a general editor cannot forge it.
CREATE TABLE vns.feed_ranking_policy_reviews (
  profile_id text NOT NULL CHECK(profile_id ~ '^[a-z][a-z0-9_-]{2,40}$'),
  profile_revision bigint NOT NULL CHECK(profile_revision >= 0),
  revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  minimum_publisher_groups integer NOT NULL CHECK(minimum_publisher_groups BETWEEN 2 AND 5),
  relevance_weight integer NOT NULL CHECK(relevance_weight BETWEEN 0 AND 100),
  freshness_weight integer NOT NULL CHECK(freshness_weight BETWEEN 0 AND 100),
  quality_weight integer NOT NULL CHECK(quality_weight BETWEEN 0 AND 100),
  explanatory_weight integer NOT NULL CHECK(explanatory_weight BETWEEN 0 AND 100),
  visualizability_weight integer NOT NULL CHECK(visualizability_weight BETWEEN 0 AND 100),
  risk_weight integer NOT NULL CHECK(risk_weight BETWEEN 0 AND 100),
  maximum_risk integer NOT NULL CHECK(maximum_risk BETWEEN 0 AND 5),
  reviewer_id uuid NOT NULL REFERENCES vns.editor_accounts(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(profile_id,profile_revision,revision)
);
CREATE TABLE vns.feed_publisher_provenance_reviews (
  source_id text NOT NULL CHECK(source_id ~ '^[a-z][a-z0-9_-]{2,40}$'),
  source_revision bigint NOT NULL CHECK(source_revision > 0),
  publisher_group text NOT NULL CHECK(publisher_group ~ '^[a-z][a-z0-9_-]{2,40}$'),
  quality integer NOT NULL CHECK(quality BETWEEN 0 AND 5),
  reviewer_id uuid NOT NULL REFERENCES vns.editor_accounts(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(source_id,source_revision)
);
CREATE TABLE vns.feed_event_factor_reviews (
  event_id uuid NOT NULL REFERENCES vns.research_events(event_id) ON DELETE RESTRICT,
  profile_id text NOT NULL CHECK(profile_id ~ '^[a-z][a-z0-9_-]{2,40}$'),
  profile_revision bigint NOT NULL CHECK(profile_revision >= 0),
  policy_revision bigint NOT NULL CHECK(policy_revision > 0),
  explanatory_value integer NOT NULL CHECK(explanatory_value BETWEEN 0 AND 5),
  visualizability integer NOT NULL CHECK(visualizability BETWEEN 0 AND 5),
  risk integer NOT NULL CHECK(risk BETWEEN 0 AND 5),
  reviewer_id uuid NOT NULL REFERENCES vns.editor_accounts(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(event_id,profile_id,profile_revision,policy_revision),
  FOREIGN KEY(profile_id,profile_revision,policy_revision)
    REFERENCES vns.feed_ranking_policy_reviews(profile_id,profile_revision,revision)
    ON DELETE RESTRICT
);
CREATE FUNCTION vns.guard_immutable_feed_rank_review()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $guard$
BEGIN
  RAISE EXCEPTION 'Reviewed ranking evidence is immutable' USING ERRCODE='42501';
END;
$guard$;
CREATE TRIGGER immutable_policy_review BEFORE UPDATE OR DELETE
  ON vns.feed_ranking_policy_reviews FOR EACH ROW
  EXECUTE FUNCTION vns.guard_immutable_feed_rank_review();
CREATE TRIGGER immutable_publisher_review BEFORE UPDATE OR DELETE
  ON vns.feed_publisher_provenance_reviews FOR EACH ROW
  EXECUTE FUNCTION vns.guard_immutable_feed_rank_review();
CREATE TRIGGER immutable_factor_review BEFORE UPDATE OR DELETE
  ON vns.feed_event_factor_reviews FOR EACH ROW
  EXECUTE FUNCTION vns.guard_immutable_feed_rank_review();
REVOKE ALL ON vns.feed_ranking_policy_reviews,
  vns.feed_publisher_provenance_reviews,
  vns.feed_event_factor_reviews FROM PUBLIC;
GRANT SELECT ON vns.feed_ranking_policy_reviews,
  vns.feed_publisher_provenance_reviews,
  vns.feed_event_factor_reviews TO vns_feed_project_executor,vns_p2_named_executor;
ALTER TABLE vns.feed_event_rankings ADD COLUMN policy_revision bigint
  CHECK(policy_revision IS NULL OR policy_revision > 0);

-- The source registry and host authorizations are independently checked
-- by the already guarded projector before this helper is reached. Source
-- IDs are NOT counted as independent publishers. Unreviewed weights or
-- provenance yield no weighted row; never manufacture factors from titles.
CREATE FUNCTION vns.reviewed_feed_weighted_score(
  p_event uuid,p_profile text,p_revision bigint,
  p_matches integer,p_max_age integer,p_newest timestamptz
) RETURNS TABLE(
  score integer,policy_revision bigint,publisher_count integer,
  reasons jsonb
) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $body$
DECLARE
  p record;
  f record;
  source_rev bigint;
  expected_sources integer;
  reviewed_sources integer;
  quality_mean numeric;
  hours_old numeric;
BEGIN
  SELECT * INTO p FROM vns.feed_ranking_policy_reviews policy
    WHERE policy.profile_id=p_profile AND policy.profile_revision=p_revision
    ORDER BY policy.revision DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT revision INTO source_rev FROM vns.admin_source_registry WHERE singleton=true;
  IF source_rev IS NULL OR p_max_age NOT BETWEEN 1 AND 720
     OR p_newest IS NULL OR p_newest>clock_timestamp()
  THEN RETURN; END IF;
  SELECT count(*)::integer,count(s.source_id)::integer,
         count(DISTINCT s.publisher_group)::integer,
         avg(s.quality::numeric)
    INTO expected_sources,reviewed_sources,publisher_count,quality_mean
  FROM (
    SELECT DISTINCT a.source_key
    FROM vns.research_event_articles ea
    JOIN vns.research_articles a ON a.article_id=ea.article_id
    WHERE ea.event_id=p_event
  ) ids
  LEFT JOIN vns.feed_publisher_provenance_reviews s
    ON s.source_id=ids.source_key AND s.source_revision=source_rev;
  IF expected_sources<2 OR expected_sources<>reviewed_sources
     OR publisher_count<p.minimum_publisher_groups
  THEN RETURN; END IF;
  SELECT * INTO f FROM vns.feed_event_factor_reviews factors
   WHERE factors.event_id=p_event
     AND factors.profile_id=p_profile
     AND factors.profile_revision=p_revision
     AND factors.policy_revision=p.revision;
  IF NOT FOUND OR f.risk>p.maximum_risk THEN RETURN; END IF;
  hours_old:=greatest(0,extract(epoch FROM (clock_timestamp()-p_newest))/3600);
  score:=least(1000,greatest(0,round(
      p_matches*p.relevance_weight
      +greatest(0,1-hours_old/p_max_age)*p.freshness_weight
      +(quality_mean/5)*p.quality_weight
      +(f.explanatory_value::numeric/5)*p.explanatory_weight
      +(f.visualizability::numeric/5)*p.visualizability_weight
      -(f.risk::numeric/5)*p.risk_weight
  )::integer));
  policy_revision:=p.revision;
  reasons:=jsonb_build_array(
    'metadata_weighted_candidate_only','independent_verification_required',
    'keyword_matches:'||p_matches::text,
    'distinct_source_ids:'||expected_sources::text,
    'publisher_groups:'||publisher_count::text,
    'policy_revision:'||p.revision::text,
    'risk_level:'||f.risk::text,
    'explanatory_level:'||f.explanatory_value::text,
    'visualizability_level:'||f.visualizability::text
  );
  RETURN NEXT;
END;
$body$;
REVOKE ALL ON FUNCTION vns.reviewed_feed_weighted_score(uuid,text,bigint,integer,integer,timestamptz)
  FROM PUBLIC;
ALTER FUNCTION vns.reviewed_feed_weighted_score(uuid,text,bigint,integer,integer,timestamptz)
  OWNER TO vns_feed_project_executor;

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
    source_count,reasons,approved_for_publication,policy_revision
  )
  SELECT c.event_id,c.profile_id,c.revision,
    COALESCE(w.score,
      least(1000,c.matches*10+c.source_count*3+
        greatest(0,floor((c.profile->>'maximumArticleAgeHours')::integer-
          extract(epoch FROM (clock_timestamp()-c.newest_at))/3600)::integer))),
    c.article_count,c.source_count,
    COALESCE(w.reasons,jsonb_build_array(
      'metadata_candidate_only','independent_verification_required',
      'keyword_matches:'||c.matches::text,
      'distinct_source_ids:'||c.source_count::text
    )),false,w.policy_revision
  FROM candidates c
  LEFT JOIN LATERAL vns.reviewed_feed_weighted_score(
    c.event_id,c.profile_id,c.revision,c.matches,
    (c.profile->>'maximumArticleAgeHours')::integer,c.newest_at) w ON true
  WHERE (NOT EXISTS(
     SELECT 1 FROM vns.feed_ranking_policy_reviews pol
     WHERE pol.profile_id=c.profile_id AND pol.profile_revision=c.revision
  ) OR w.score IS NOT NULL)
  ORDER BY c.event_id,c.profile_id LIMIT p_limit
  ON CONFLICT(event_id,profile_id,profile_revision) DO UPDATE
  SET score=EXCLUDED.score,
      article_count=EXCLUDED.article_count,
      source_count=EXCLUDED.source_count,
      reasons=EXCLUDED.reasons,
      policy_revision=EXCLUDED.policy_revision,
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
  -- Once reviewed weights are enabled for a profile revision, legacy
  -- rows and obsolete policy revisions must not masquerade as current.
  AND (
    (r.policy_revision IS NULL AND NOT EXISTS(
      SELECT 1 FROM vns.feed_ranking_policy_reviews pol
      WHERE pol.profile_id=r.profile_id AND pol.profile_revision=r.profile_revision
    ))
    OR (
      r.policy_revision=(
        SELECT max(pol.revision) FROM vns.feed_ranking_policy_reviews pol
        WHERE pol.profile_id=r.profile_id AND pol.profile_revision=r.profile_revision)
      AND EXISTS(
        SELECT 1 FROM vns.feed_event_factor_reviews f
        JOIN vns.feed_ranking_policy_reviews pol
         ON pol.profile_id=f.profile_id AND pol.profile_revision=f.profile_revision
           AND pol.revision=f.policy_revision
        WHERE f.event_id=r.event_id AND f.profile_id=r.profile_id
          AND f.profile_revision=r.profile_revision
          AND f.policy_revision=r.policy_revision
          AND f.risk<=pol.maximum_risk
      )
      AND NOT EXISTS(
        SELECT 1 FROM vns.research_event_articles ea
        JOIN vns.research_articles a ON a.article_id=ea.article_id
        LEFT JOIN vns.feed_publisher_provenance_reviews provenance
          ON provenance.source_id=a.source_key
            AND provenance.source_revision=(
              SELECT revision FROM vns.admin_source_registry WHERE singleton=true)
        WHERE ea.event_id=r.event_id AND provenance.source_id IS NULL
      )
    )
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
INSERT INTO vns.schema_migrations(version) VALUES('0053_reviewed_weighted_rankings');
COMMIT;
