-- P2-02 / 0019: dormant, reversible CI-only feed polling state.
-- NEVER migrate the VPS without approved recovery, keys and least-privilege login.
BEGIN;
CREATE ROLE vns_feed_poll_executor NOLOGIN NOINHERIT;
CREATE ROLE vns_feed_poll_writer NOLOGIN NOINHERIT;
GRANT USAGE ON SCHEMA vns TO vns_feed_poll_executor, vns_feed_poll_writer;

CREATE TABLE vns.feed_poll_state (
  source_id text PRIMARY KEY CHECK (source_id ~ '^[a-z][a-z0-9_-]{2,40}$'),
  next_eligible_at timestamptz NOT NULL,
  lease_token uuid NOT NULL,
  etag text CHECK (etag IS NULL OR (length(etag) BETWEEN 1 AND 200 AND etag !~ '[[:cntrl:]]')),
  last_modified text CHECK (last_modified IS NULL OR
    (length(last_modified) BETWEEN 1 AND 200 AND last_modified !~ '[[:cntrl:]]'))
);
CREATE TABLE vns.feed_poll_candidates (
  source_id text NOT NULL REFERENCES vns.feed_poll_state(source_id) ON DELETE RESTRICT,
  article_url text NOT NULL CHECK (length(article_url) BETWEEN 16 AND 512 AND
    article_url ~ '^https://'),
  headline text NOT NULL CHECK (length(btrim(headline)) BETWEEN 8 AND 200),
  published_at timestamptz,
  review_status text NOT NULL DEFAULT 'candidate' CHECK (review_status='candidate'),
  discovered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_id, article_url)
);

-- Executor owns the trusted functions. The future writer gets EXECUTE only;
-- it cannot inspect, forge or modify the two tables directly.
GRANT SELECT, INSERT, UPDATE ON vns.feed_poll_state TO vns_feed_poll_executor;
GRANT SELECT, INSERT ON vns.feed_poll_candidates TO vns_feed_poll_executor;

CREATE FUNCTION vns.claim_feed_poll(p_source text, p_interval_minutes integer)
RETURNS TABLE(token uuid, etag text, last_modified text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $claim$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_source IS NULL OR p_source !~ '^[a-z][a-z0-9_-]{2,40}$'
    OR p_interval_minutes IS NULL OR p_interval_minutes NOT BETWEEN 15 AND 10080
  THEN
    RAISE EXCEPTION 'Feed claim arguments invalid' USING ERRCODE='22023';
  END IF;
  -- Atomic UPSERT serializes concurrent claims on a single source_id.
  -- Database clock is authoritative, never a browser or worker clock.
  RETURN QUERY
    INSERT INTO vns.feed_poll_state AS state
      (source_id,next_eligible_at,lease_token)
    VALUES (p_source,v_now+make_interval(mins=>p_interval_minutes),gen_random_uuid())
    ON CONFLICT (source_id) DO UPDATE
      SET next_eligible_at=EXCLUDED.next_eligible_at,
          lease_token=EXCLUDED.lease_token
      WHERE state.next_eligible_at <= v_now
    RETURNING state.lease_token,state.etag,state.last_modified;
END;
$claim$;

CREATE FUNCTION vns.commit_feed_poll(
  p_source text, p_token uuid, p_items jsonb,
  p_etag text, p_last_modified text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $commit$
DECLARE
  v_item jsonb;
  v_url text;
  v_headline text;
  v_published text;
  v_count integer := 0;
  v_affected integer;
BEGIN
  IF p_source IS NULL OR p_token IS NULL
    OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_items) > 20
    OR (p_etag IS NOT NULL AND (length(p_etag) NOT BETWEEN 1 AND 200 OR p_etag ~ '[[:cntrl:]]'))
    OR (p_last_modified IS NOT NULL AND
       (length(p_last_modified) NOT BETWEEN 1 AND 200 OR p_last_modified ~ '[[:cntrl:]]'))
  THEN
    RAISE EXCEPTION 'Feed commit arguments invalid' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM vns.feed_poll_state
    WHERE source_id=p_source AND lease_token=p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Feed lease no longer valid' USING ERRCODE='42501';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(v_item) <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(v_item)) <> 3
      OR NOT (v_item ?& ARRAY['url','headline','publishedAt'])
      OR jsonb_typeof(v_item->'url') <> 'string'
      OR jsonb_typeof(v_item->'headline') <> 'string'
      OR jsonb_typeof(v_item->'publishedAt') NOT IN ('string','null')
    THEN
      RAISE EXCEPTION 'Feed item shape invalid' USING ERRCODE='22023';
    END IF;
    v_url := v_item->>'url';
    v_headline := v_item->>'headline';
    v_published := v_item->>'publishedAt';
    IF v_url !~ '^https://[a-z0-9-]+([.][a-z0-9-]+)+/' OR length(v_url) > 512
      OR length(v_headline) NOT BETWEEN 8 AND 200
      OR v_headline ~ '[[:cntrl:]]' OR v_headline <> btrim(v_headline)
    THEN
      RAISE EXCEPTION 'Feed item metadata invalid' USING ERRCODE='22023';
    END IF;
    INSERT INTO vns.feed_poll_candidates (source_id,article_url,headline,published_at)
    VALUES (p_source,v_url,v_headline,v_published::timestamptz)
    ON CONFLICT (source_id,article_url) DO NOTHING;
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    v_count := v_count + v_affected;
  END LOOP;
  UPDATE vns.feed_poll_state
    SET etag=p_etag,last_modified=p_last_modified
    WHERE source_id=p_source AND lease_token=p_token;
  RETURN v_count;
END;
$commit$;

REVOKE ALL ON FUNCTION vns.claim_feed_poll(text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION vns.commit_feed_poll(text,uuid,jsonb,text,text) FROM PUBLIC;
ALTER FUNCTION vns.claim_feed_poll(text,integer) OWNER TO vns_feed_poll_executor;
ALTER FUNCTION vns.commit_feed_poll(text,uuid,jsonb,text,text) OWNER TO vns_feed_poll_executor;
GRANT EXECUTE ON FUNCTION vns.claim_feed_poll(text,integer) TO vns_feed_poll_writer;
GRANT EXECUTE ON FUNCTION vns.commit_feed_poll(text,uuid,jsonb,text,text) TO vns_feed_poll_writer;

COMMENT ON TABLE vns.feed_poll_candidates IS
  'Dormant metadata-only editorial candidates; no fulltext, license approval or verified claims.';
INSERT INTO vns.schema_migrations(version) VALUES ('0019_feed_poll_contract');
COMMIT;
