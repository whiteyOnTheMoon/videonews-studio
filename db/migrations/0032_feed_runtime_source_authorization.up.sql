-- P2-01/P2-02: runtime approval against the current, audited source and host records.
-- No automatic VPS migration or source activation.
BEGIN;
CREATE ROLE vns_feed_source_authority NOLOGIN NOINHERIT;
GRANT USAGE ON SCHEMA vns TO vns_feed_source_authority;
GRANT SELECT, UPDATE(singleton) ON vns.admin_source_registry,
  vns.admin_source_host_approvals TO vns_feed_source_authority;
GRANT SELECT ON vns.admin_source_host_audit TO vns_feed_source_authority;

CREATE FUNCTION vns.feed_runtime_source_authorized(p_source jsonb)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog
AS $body$
DECLARE
  v_revision bigint;
  v_sources jsonb;
  v_hosts jsonb;
  v_host text;
  v_host_action text;
  v_grant_source_revision bigint;
BEGIN
  IF p_source IS NULL OR jsonb_typeof(p_source) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_source)) <> 9
    OR NOT (p_source ?& ARRAY['id','baseUrl','access','intervalMinutes',
                             'termsUrl','usage','licenseNotes','status','reviewedAt'])
    OR p_source->>'status' IS DISTINCT FROM 'approved'
  THEN RETURN false; END IF;

  -- Both governance rows are locked for this SQL transaction. Caller cannot
  -- gain table access; a concurrent revoke cannot overtake this decision.
  SELECT revision,sources INTO v_revision,v_sources
    FROM vns.admin_source_registry WHERE singleton=true FOR SHARE;
  IF NOT FOUND OR v_revision < 1 THEN RETURN false; END IF;
  SELECT approved_hosts INTO v_hosts FROM vns.admin_source_host_approvals
    WHERE singleton=true FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_sources) AS entry
    WHERE entry.value = p_source AND entry.value->>'status' = 'approved'
  ) THEN RETURN false; END IF;

  v_host := split_part(split_part(p_source->>'baseUrl','https://',2),'/',1);
  IF v_host IS NULL OR length(v_host) NOT BETWEEN 4 AND 253
    OR NOT (v_hosts ? v_host)
  THEN RETURN false; END IF;

  -- Host approval must still apply to the EXACT source snapshot generation.
  -- Source changes after a grant intentionally stop polling until the distinct
  -- human host-grant path is exercised again.
  SELECT action,source_revision INTO v_host_action,v_grant_source_revision
    FROM vns.admin_source_host_audit
    WHERE host=v_host ORDER BY revision DESC LIMIT 1;
  RETURN v_host_action = 'grant' AND v_grant_source_revision = v_revision;
END;
$body$;
REVOKE ALL ON FUNCTION vns.feed_runtime_source_authorized(jsonb) FROM PUBLIC;
ALTER FUNCTION vns.feed_runtime_source_authorized(jsonb) OWNER TO vns_feed_source_authority;
GRANT EXECUTE ON FUNCTION vns.feed_runtime_source_authorized(jsonb)
  TO vns_feed_poll_writer;
COMMENT ON FUNCTION vns.feed_runtime_source_authorized(jsonb) IS
  'Fail-closed current admin source/host snapshot admission, not a signature, license grant, or continuous lock during HTTPS.';
INSERT INTO vns.schema_migrations(version) VALUES('0032_feed_runtime_source_authorization');
COMMIT;
