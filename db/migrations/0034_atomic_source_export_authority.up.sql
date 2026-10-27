-- P2-01: atomic read-only source + independently reviewed host snapshot.
-- Does not activate network access, schedulers, signing keys or VPS migration.
BEGIN;
CREATE ROLE vns_source_export_authority NOLOGIN NOINHERIT;
CREATE ROLE vns_source_export_reader NOLOGIN NOINHERIT;
GRANT USAGE ON SCHEMA vns TO vns_source_export_authority,vns_source_export_reader;
GRANT SELECT, UPDATE(singleton) ON vns.admin_source_registry,
  vns.admin_source_host_approvals TO vns_source_export_authority;
GRANT SELECT ON vns.admin_source_host_audit TO vns_source_export_authority;

CREATE FUNCTION vns.read_approved_source_export()
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog
AS $body$
DECLARE
  v_source_revision bigint;
  v_host_revision bigint;
  v_sources jsonb;
  v_hosts jsonb;
  v_host text;
  v_latest_action text;
  v_approved_source_revision bigint;
BEGIN
  -- These shared locks prevent concurrent edits, grants and revocations from
  -- producing mixed-revision data in the returned envelope.
  SELECT revision,sources INTO v_source_revision,v_sources
    FROM vns.admin_source_registry WHERE singleton=true FOR SHARE;
  IF NOT FOUND OR v_source_revision < 1 OR v_source_revision > 9007199254740991
    OR jsonb_typeof(v_sources) IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_sources) NOT BETWEEN 1 AND 20
  THEN
    RAISE EXCEPTION 'Approved source snapshot unavailable' USING ERRCODE='42501';
  END IF;
  SELECT revision,approved_hosts INTO v_host_revision,v_hosts
    FROM vns.admin_source_host_approvals WHERE singleton=true FOR SHARE;
  IF NOT FOUND OR v_host_revision < 1 OR v_host_revision > 9007199254740991
    OR jsonb_typeof(v_hosts) IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_hosts) NOT BETWEEN 1 AND 5
  THEN
    RAISE EXCEPTION 'Approved host snapshot unavailable' USING ERRCODE='42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_hosts) AS host
    WHERE jsonb_typeof(host.value) IS DISTINCT FROM 'string'
  ) OR (
    SELECT count(DISTINCT value) FROM jsonb_array_elements_text(v_hosts) AS value
  ) <> jsonb_array_length(v_hosts) THEN
    RAISE EXCEPTION 'Approved host snapshot invalid' USING ERRCODE='42501';
  END IF;
  FOR v_host IN SELECT value FROM jsonb_array_elements_text(v_hosts) AS value LOOP
    SELECT action,source_revision INTO v_latest_action,v_approved_source_revision
      FROM vns.admin_source_host_audit
      WHERE host=v_host ORDER BY revision DESC LIMIT 1;
    IF v_latest_action IS DISTINCT FROM 'grant'
      OR v_approved_source_revision IS DISTINCT FROM v_source_revision
    THEN
      RAISE EXCEPTION 'Stale or revoked host source approval' USING ERRCODE='42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_sources) AS item
      WHERE item.value->>'status'='approved'
        AND split_part(split_part(item.value->>'baseUrl','https://',2),'/',1)=v_host
    ) THEN
      RAISE EXCEPTION 'Host has no currently approved source' USING ERRCODE='42501';
    END IF;
  END LOOP;
  -- The TS publisher validates ALL entries, scopes, ordering and equal host
  -- sets again; SQL is the atomic audited snapshot authority.
  RETURN jsonb_build_object(
    'sourceSnapshot',jsonb_build_object(
      'revision',v_source_revision,'sources',v_sources),
    'hostApproval',jsonb_build_object(
      'revision',v_host_revision,'approvedHosts',v_hosts));
END;
$body$;
REVOKE ALL ON FUNCTION vns.read_approved_source_export() FROM PUBLIC;
ALTER FUNCTION vns.read_approved_source_export()
  OWNER TO vns_source_export_authority;
GRANT EXECUTE ON FUNCTION vns.read_approved_source_export()
  TO vns_source_export_reader;
COMMENT ON FUNCTION vns.read_approved_source_export() IS
  'Read-only source/host governance snapshot; not a human approval, signing operation, or network authorization.';
INSERT INTO vns.schema_migrations(version)
  VALUES('0034_atomic_source_export_authority');
COMMIT;
