-- P2-01..04: atomically persist metadata-only ranked event snapshots
-- within the already approved feed candidate projection, and offer a
-- personal-read-only Admin query. NO LOGIN enrollment or live activation.
BEGIN;

CREATE TABLE vns.feed_event_rankings (
  event_id uuid NOT NULL REFERENCES vns.research_events(event_id) ON DELETE RESTRICT,
  profile_id text NOT NULL CHECK (profile_id ~ '^[a-z][a-z0-9_-]{2,40}$'),
  profile_revision bigint NOT NULL CHECK (profile_revision >= 0),
  score integer NOT NULL CHECK (score BETWEEN 0 AND 1000),
  article_count integer NOT NULL CHECK (article_count BETWEEN 1 AND 100),
  source_count integer NOT NULL CHECK (source_count BETWEEN 1 AND 100),
  reasons jsonb NOT NULL CHECK (
    jsonb_typeof(reasons)='array'
    AND jsonb_array_length(reasons) BETWEEN 2 AND 10
    AND octet_length(reasons::text) <= 1024
  ),
  ranked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_for_publication boolean NOT NULL DEFAULT false
    CHECK (approved_for_publication=false),
  PRIMARY KEY(event_id,profile_id,profile_revision)
);
CREATE INDEX feed_event_rankings_display_idx
 ON vns.feed_event_rankings(profile_revision,score DESC,ranked_at DESC);
REVOKE ALL ON vns.feed_event_rankings FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON vns.feed_event_rankings TO vns_feed_project_executor;
GRANT SELECT ON vns.editorial_profile_registry TO vns_feed_project_executor;

-- Internal metadata-only scorer. The already guarded source projection is
-- the ONLY caller; this function gets no client/PUBLIC EXECUTE. Every event
-- must contain the projected source and *all* its source IDs must remain
-- in the current reviewed source registry and pass DB authorization.
CREATE FUNCTION vns.refresh_approved_feed_rankings(
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
           regexp_replace(lower(e.label),'[^[:alnum:]]+',' ','g') AS normalized_title
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
      WHERE (' '||regexp_replace(lower(e.label),'[^[:alnum:]]+',' ','g')||' ')
        LIKE ('% '||regexp_replace(lower(term.value),'[^[:alnum:]]+',' ','g')||' %')
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
      WHERE (' '||regexp_replace(lower(e.label),'[^[:alnum:]]+',' ','g')||' ')
        LIKE ('% '||regexp_replace(lower(term.value),'[^[:alnum:]]+',' ','g')||' %')
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

REVOKE ALL ON FUNCTION vns.refresh_approved_feed_rankings(text,integer) FROM PUBLIC;
ALTER FUNCTION vns.refresh_approved_feed_rankings(text,integer)
  OWNER TO vns_feed_project_executor;

-- Rewrite the existing *approved* projection to rank in the same transaction,
-- retaining all original reviewed-source and URL-scope guards.
CREATE OR REPLACE FUNCTION vns.project_approved_feed_candidates(p_source text,p_limit integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $body$
DECLARE
  v_source jsonb;
  v_sources jsonb;
  v_scope text;
  v_matches integer;
  v_added integer;
BEGIN
  IF p_source IS NULL OR p_source !~ '^[a-z][a-z0-9_-]{2,40}$'
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
  THEN RAISE EXCEPTION 'Feed projection request invalid' USING ERRCODE='22023'; END IF;

  -- Lock the current reviewed registry and host grant through the projector
  -- transaction; a concurrent edit/revoke cannot overtake this operation.
  SELECT sources INTO v_sources FROM vns.admin_source_registry
    WHERE singleton=true FOR SHARE;
  IF NOT FOUND OR jsonb_typeof(v_sources) IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'Feed source approval unavailable' USING ERRCODE='42501'; END IF;
  SELECT count(*),max(entry.value::text)::jsonb
  INTO v_matches,v_source
  FROM jsonb_array_elements(v_sources) AS entry
  WHERE entry.value->>'id'=p_source;
  IF v_matches IS DISTINCT FROM 1
     OR NOT vns.feed_runtime_source_authorized(v_source)
  THEN RAISE EXCEPTION 'Feed source projection not authorized' USING ERRCODE='42501'; END IF;

  v_scope := v_source->>'baseUrl';
  IF v_scope IS NULL OR v_scope !~ '^https://[^[:space:]?#]+/$'
  THEN RAISE EXCEPTION 'Invalid source scope' USING ERRCODE='42501'; END IF;

  -- Never promote a candidate that is now outside its approved URL scope
  -- or below a more specific potentially pending/blocked child-source scope.
  -- Fail the entire batch instead of silently mixing permitted and denied rows.
  IF EXISTS (
    SELECT 1 FROM vns.feed_poll_candidates c
    WHERE c.source_id=p_source AND c.review_status='candidate'
      AND (left(c.article_url,length(v_scope)) IS DISTINCT FROM v_scope
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_sources) AS child
         WHERE child.value->>'id' IS DISTINCT FROM p_source
           AND length(child.value->>'baseUrl')>length(v_scope)
           AND left(c.article_url,length(child.value->>'baseUrl'))=child.value->>'baseUrl'
       ))
  ) THEN RAISE EXCEPTION 'Feed candidate scope no longer authorized'
    USING ERRCODE='42501'; END IF;

  v_added := vns.project_feed_candidates(p_source,p_limit);
  -- Ranking is part of the same atomic, already-authorized projection call.
  -- A ranking failure rolls back projection; no partial recorded success.
  PERFORM vns.refresh_approved_feed_rankings(p_source,p_limit);
  RETURN v_added;
END;
$body$;

ALTER FUNCTION vns.project_approved_feed_candidates(text,integer)
  OWNER TO vns_feed_project_executor;
REVOKE ALL ON FUNCTION vns.project_approved_feed_candidates(text,integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vns.project_approved_feed_candidates(text,integer)
  TO vns_feed_project_client;

-- Named, admin-only read of durable snapshots. No general API/worker SELECT.
GRANT SELECT ON vns.feed_event_rankings,vns.research_events,
  vns.research_event_articles,vns.research_articles,vns.admin_source_registry
  TO vns_p2_named_executor;
GRANT EXECUTE ON FUNCTION vns.feed_runtime_source_authorized(jsonb)
  TO vns_p2_named_executor;
CREATE FUNCTION vns.named_ranked_feed_page(p_limit integer)
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
REVOKE ALL ON FUNCTION vns.named_ranked_feed_page(integer) FROM PUBLIC;
ALTER FUNCTION vns.named_ranked_feed_page(integer) OWNER TO vns_p2_named_executor;
GRANT EXECUTE ON FUNCTION vns.named_ranked_feed_page(integer)
  TO vns_p2_named_client;

INSERT INTO vns.schema_migrations(version)
VALUES ('0049_approved_feed_rankings');
COMMIT;
