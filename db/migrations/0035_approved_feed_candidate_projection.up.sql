-- P2-03: named, separately gated projection from approved feed metadata.
-- Forward-only release migration; does not enroll a LOGIN or activate a worker.
BEGIN;

-- Dedicated NOLOGIN caller can execute only the guarded version.
CREATE ROLE vns_feed_project_client NOLOGIN NOINHERIT;
GRANT USAGE ON SCHEMA vns TO vns_feed_project_client;
GRANT SELECT ON vns.admin_source_registry TO vns_feed_project_executor;
GRANT EXECUTE ON FUNCTION vns.feed_runtime_source_authorized(jsonb)
  TO vns_feed_project_executor;

CREATE FUNCTION vns.project_approved_feed_candidates(p_source text,p_limit integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $body$
DECLARE
  v_source jsonb;
  v_sources jsonb;
  v_scope text;
  v_matches integer;
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

  RETURN vns.project_feed_candidates(p_source,p_limit);
END;
$body$;

REVOKE ALL ON FUNCTION vns.project_approved_feed_candidates(text,integer)
  FROM PUBLIC;
ALTER FUNCTION vns.project_approved_feed_candidates(text,integer)
  OWNER TO vns_feed_project_executor;
GRANT EXECUTE ON FUNCTION vns.project_approved_feed_candidates(text,integer)
  TO vns_feed_project_client;

-- Runtime API, polling, and general workers retain no projection grants.
REVOKE ALL ON FUNCTION vns.project_feed_candidates(text,integer)
  FROM PUBLIC,vns_feed_project_client;

INSERT INTO vns.schema_migrations(version)
  VALUES('0035_approved_feed_candidate_projection');
COMMIT;
