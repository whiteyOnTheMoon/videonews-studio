-- Revert P2-04 ranked feed persistence without touching existing feed articles.
BEGIN;
CREATE OR REPLACE FUNCTION vns.project_approved_feed_candidates(p_source text,p_limit integer)
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

ALTER FUNCTION vns.project_approved_feed_candidates(text,integer)
 OWNER TO vns_feed_project_executor;
DROP FUNCTION vns.named_ranked_feed_page(integer);
DROP FUNCTION vns.refresh_approved_feed_rankings(text,integer);
DROP TABLE vns.feed_event_rankings;
-- Grants on pre-existing objects must also be undone, or the original
-- NOLOGIN principals cannot be dropped by the reversible migrations.
REVOKE SELECT ON vns.editorial_profile_registry FROM vns_feed_project_executor;
REVOKE SELECT ON vns.research_events,vns.research_event_articles,
  vns.research_articles,vns.admin_source_registry FROM vns_p2_named_executor;
REVOKE EXECUTE ON FUNCTION vns.feed_runtime_source_authorized(jsonb)
  FROM vns_p2_named_executor;
DELETE FROM vns.schema_migrations WHERE version='0049_approved_feed_rankings';
COMMIT;
