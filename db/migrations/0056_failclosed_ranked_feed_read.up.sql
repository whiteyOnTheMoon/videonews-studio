-- P2-A 0056: fail-closed named Admin ranking read under stale evidence.
-- Changes display eligibility only; no ranking scores or audit records rewritten.
BEGIN;
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
  -- Fail closed on stale event membership: the published SQL score was
  -- computed for exactly these articles and distinct source IDs.
  -- A later projection may update either set without re-ranking the row.
  AND (
    SELECT count(*)::integer
    FROM vns.research_event_articles ea
    WHERE ea.event_id=r.event_id
  )=r.article_count
  AND (
    SELECT count(DISTINCT a.source_key)::integer
    FROM vns.research_event_articles ea
    JOIN vns.research_articles a ON a.article_id=ea.article_id
    WHERE ea.event_id=r.event_id
  )=r.source_count
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(p.profiles) prof(value)
    WHERE prof.value->>'id'=r.profile_id
      AND r.source_count >= (prof.value->>'minIndependentSources')::integer
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
      -- Source count does not establish publisher independence. Match the
      -- distinct reviewed groups against the CURRENT immutable policy.
      -- This is intentionally rechecked even for an already saved score.
      AND (
        SELECT count(DISTINCT provenance.publisher_group)::integer
        FROM vns.research_event_articles ea
        JOIN vns.research_articles a ON a.article_id=ea.article_id
        JOIN vns.feed_publisher_provenance_reviews provenance
          ON provenance.source_id=a.source_key
         AND provenance.source_revision=(
           SELECT revision FROM vns.admin_source_registry WHERE singleton=true)
        WHERE ea.event_id=r.event_id
      ) >= (
        SELECT pol.minimum_publisher_groups
        FROM vns.feed_ranking_policy_reviews pol
        WHERE pol.profile_id=r.profile_id
          AND pol.profile_revision=r.profile_revision
          AND pol.revision=r.policy_revision
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
INSERT INTO vns.schema_migrations(version)
 VALUES('0056_failclosed_ranked_feed_read');
COMMIT;
