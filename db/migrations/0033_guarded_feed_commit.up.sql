-- P2-01/P2-02: new guarded feed claim/commit, with one-statement governance locks.
-- Reversible CI-only contract; do not apply to the VPS without a rollout plan.
-- Production backup, migration ordering and reviewer enrollment require separate operator approval.
BEGIN;
-- The NOLOGIN security-definer authority may invoke only the already bounded
-- feed functions. The authenticated feed writer will lose those direct grants.
GRANT EXECUTE ON FUNCTION vns.claim_feed_poll(text,integer)
  TO vns_feed_source_authority;
GRANT EXECUTE ON FUNCTION vns.commit_feed_poll(text,uuid,jsonb,text,text)
  TO vns_feed_source_authority;

CREATE FUNCTION vns.claim_feed_poll_authorized(p_source jsonb,p_interval integer)
RETURNS TABLE(token uuid,etag text,last_modified text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog
AS $body$
BEGIN
  IF p_source IS NULL OR p_source->>'status' IS DISTINCT FROM 'approved'
    OR jsonb_typeof(p_source->'intervalMinutes') IS DISTINCT FROM 'number'
    OR (p_source->>'intervalMinutes')::integer IS DISTINCT FROM p_interval
    OR NOT vns.feed_runtime_source_authorized(p_source)
  THEN
    RAISE EXCEPTION 'Feed claim authorization denied' USING ERRCODE='42501';
  END IF;
  -- Current source and host locks are held through the underlying lease claim.
  RETURN QUERY SELECT c.token,c.etag,c.last_modified
    FROM vns.claim_feed_poll(p_source->>'id',p_interval) AS c;
END;
$body$;

CREATE FUNCTION vns.commit_feed_poll_authorized(
  p_source jsonb,p_token uuid,p_items jsonb,p_etag text,p_last_modified text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog
AS $body$
DECLARE
  v_sources jsonb;
  v_item jsonb;
  v_url text;
  v_scope text;
BEGIN
  -- Admission and the final insert execute in one PostgreSQL statement.
  -- Revokes and edits require UPDATE of rows held FOR SHARE until commit.
  IF NOT vns.feed_runtime_source_authorized(p_source)
  THEN
    RAISE EXCEPTION 'Feed commit authorization denied' USING ERRCODE='42501';
  END IF;
  SELECT sources INTO v_sources FROM vns.admin_source_registry
    WHERE singleton=true FOR SHARE;
  IF NOT FOUND OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_items) > 20
  THEN
    RAISE EXCEPTION 'Feed commit authorization denied' USING ERRCODE='42501';
  END IF;
  v_scope := p_source->>'baseUrl';
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_url := v_item->>'url';
    -- The database itself checks the full CURRENT scope registry: a blocked,
    -- pending or differently owned child cannot be omitted from a stale file.
    IF v_url IS NULL OR left(v_url,length(v_scope)) IS DISTINCT FROM v_scope
      OR strpos(v_url,'%')>0 OR strpos(v_url,'?')>0 OR strpos(v_url,'#')>0
      OR strpos(v_url,'/../')>0 OR strpos(v_url,'/./')>0
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_sources) AS child
        WHERE length(child.value->>'baseUrl')>length(v_scope)
          AND left(v_url,length(child.value->>'baseUrl'))=child.value->>'baseUrl'
      )
    THEN
      RAISE EXCEPTION 'Feed article scope denied' USING ERRCODE='42501';
    END IF;
  END LOOP;
  RETURN vns.commit_feed_poll(
    p_source->>'id',p_token,p_items,p_etag,p_last_modified
  );
END;
$body$;

REVOKE ALL ON FUNCTION vns.claim_feed_poll_authorized(jsonb,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION vns.commit_feed_poll_authorized(jsonb,uuid,jsonb,text,text) FROM PUBLIC;
ALTER FUNCTION vns.claim_feed_poll_authorized(jsonb,integer)
  OWNER TO vns_feed_source_authority;
ALTER FUNCTION vns.commit_feed_poll_authorized(jsonb,uuid,jsonb,text,text)
  OWNER TO vns_feed_source_authority;
GRANT EXECUTE ON FUNCTION vns.claim_feed_poll_authorized(jsonb,integer)
  TO vns_feed_poll_writer;
GRANT EXECUTE ON FUNCTION vns.commit_feed_poll_authorized(jsonb,uuid,jsonb,text,text)
  TO vns_feed_poll_writer;
REVOKE EXECUTE ON FUNCTION vns.claim_feed_poll(text,integer)
  FROM vns_feed_poll_writer;
REVOKE EXECUTE ON FUNCTION vns.commit_feed_poll(text,uuid,jsonb,text,text)
  FROM vns_feed_poll_writer;
INSERT INTO vns.schema_migrations(version) VALUES('0033_guarded_feed_commit');
COMMIT;
