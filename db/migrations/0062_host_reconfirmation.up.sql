-- 0062: re-confirm stale approved hosts for a newer source registry revision.
-- A new human/DBA-authorized personal decision is required; never silently
-- recycle a grant or change the allowed host set. The audit records a fresh
-- `grant` action so the pre-existing export and feed runtime guards remain strict.
BEGIN;
-- The SECURITY DEFINER owner needs only these audit columns to reject
-- a revoked/already-current host. The named client gains no direct read.
GRANT SELECT(revision,host,action,source_revision)
  ON vns.admin_source_host_audit TO vns_host_approval_executor;
CREATE OR REPLACE FUNCTION vns.admin_change_source_host_approval(
  p_expected bigint,
  p_source_revision bigint,
  p_action text,
  p_host text,
  p_reason text,
  p_editor_id uuid,
  p_auth_version integer
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $approval$
DECLARE
  v_name text;
  v_current bigint;
  v_hosts jsonb;
  v_source_revision bigint;
  v_sources jsonb;
  v_exists boolean;
  v_labels text[];
  v_label text;
  v_approval_model text := 'two_person';
  v_owner_mode_allowed boolean;
  v_previous_action text;
  v_previous_source_revision bigint;
BEGIN
  IF p_expected IS NULL OR p_expected<0 OR p_expected>=9007199254740991
    OR p_source_revision IS NULL OR p_source_revision<1
    OR p_action IS NULL OR p_action NOT IN ('grant','revoke','renew')
    OR p_host IS NULL OR length(p_host) NOT BETWEEN 4 AND 253
    OR p_host !~ '^[a-z0-9-]+([.][a-z0-9-]+)*[.][a-z]{2,}$'
    OR p_host ~ '^[0-9]+([.][0-9]+){3}$'
    OR p_host ~ '[.](local|internal|localhost|onion)$'
    OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 20 AND 300
    OR p_reason<>btrim(p_reason) OR p_reason~'[[:cntrl:]]'
    OR p_editor_id IS NULL OR p_auth_version IS NULL OR p_auth_version<0
  THEN RAISE EXCEPTION 'invalid host approval' USING ERRCODE='22023'; END IF;

  v_labels:=string_to_array(p_host,'.');
  FOREACH v_label IN ARRAY v_labels LOOP
    IF length(v_label)>63 OR v_label !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
      OR left(v_label,4)='xn--'
    THEN RAISE EXCEPTION 'invalid approval hostname' USING ERRCODE='22023'; END IF;
  END LOOP;

  -- Resolve personal actor server-side and lock revocation state until COMMIT.
  SELECT username INTO v_name FROM vns.editor_accounts
    WHERE id=p_editor_id AND active=true AND role='admin'
      AND auth_version=p_auth_version FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin identity unavailable' USING ERRCODE='42501'; END IF;

  -- Read source-state revision under a shared row lock: a simultaneous source
  -- approval or block cannot race this host grant.
  SELECT revision,sources INTO v_source_revision,v_sources
    FROM vns.admin_source_registry WHERE singleton=true FOR SHARE;
  IF NOT FOUND OR v_source_revision<>p_source_revision THEN RETURN false; END IF;

  SELECT revision,approved_hosts INTO v_current,v_hosts
    FROM vns.admin_source_host_approvals WHERE singleton=true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'host approval unavailable' USING ERRCODE='55000'; END IF;
  IF v_current<>p_expected THEN RETURN false; END IF;

  IF p_action IN ('grant','renew') THEN
    SELECT EXISTS(
      SELECT 1 FROM jsonb_array_elements(v_sources) AS source
      WHERE source->>'status'='approved'
        AND split_part(split_part(source->>'baseUrl','https://',2),'/',1)=p_host
    ) INTO v_exists;
    IF NOT v_exists THEN
      RAISE EXCEPTION 'host lacks independently reviewed source' USING ERRCODE='22023';
    END IF;
    -- The current approval must be attributable to a DIFFERENT named editor.
    -- This check runs while the source registry is locked FOR SHARE and the
    -- host approval row FOR UPDATE, so source transitions cannot race grants.
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_sources) AS entry
      CROSS JOIN LATERAL (
        SELECT a.editor_id, a.action
        FROM vns.admin_source_audit AS a
        WHERE a.source_id = entry->>'id'
        ORDER BY a.revision DESC LIMIT 1
      ) AS latest
      WHERE entry->>'status'='approved'
        AND split_part(split_part(entry->>'baseUrl','https://',2),'/',1)=p_host
        AND latest.action='approve'
        AND latest.editor_id <> p_editor_id
    ) THEN
      -- Owner exception is an explicitly DBA-enrolled governance policy.
      -- The old actor-asserting API remains unable to fake it:
      -- session_user must be the personally enrolled PostgreSQL LOGIN of
      -- the exact owner account, not a caller-provided UUID or SET ROLE.
      SELECT EXISTS (
        SELECT 1
        FROM vns.single_owner_review_policy policy
        JOIN vns.editor_db_principals principal
          ON principal.editor_id=policy.owner_editor_id
          AND principal.login_role=session_user
          AND principal.active=true
        JOIN vns.editor_accounts owner_account
          ON owner_account.id=principal.editor_id
        WHERE policy.singleton=true
          AND policy.enabled=true
          AND policy.owner_editor_id=p_editor_id
          AND principal.auth_version=p_auth_version
          AND owner_account.active=true
          AND owner_account.role='admin'
          AND owner_account.auth_version=p_auth_version
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(v_sources) AS entry
            CROSS JOIN LATERAL (
              SELECT a.editor_id,a.action
              FROM vns.admin_source_audit a
              WHERE a.source_id=entry->>'id'
              ORDER BY a.revision DESC LIMIT 1
            ) AS latest
            WHERE entry->>'status'='approved'
              AND split_part(split_part(entry->>'baseUrl','https://',2),'/',1)=p_host
              AND latest.action='approve'
              AND latest.editor_id=p_editor_id
          )
      ) INTO v_owner_mode_allowed;
      IF NOT v_owner_mode_allowed THEN
        RAISE EXCEPTION 'independent review or enrolled owner required'
          USING ERRCODE='42501';
      END IF;
      v_approval_model:='single_owner';
    END IF;
    IF p_action='grant' THEN
      IF v_hosts ? p_host OR jsonb_array_length(v_hosts)>=5 THEN
        RAISE EXCEPTION 'host already approved or grant cap reached' USING ERRCODE='22023';
      END IF;
      SELECT jsonb_agg(value ORDER BY value) INTO v_hosts
        FROM (
          SELECT value FROM jsonb_array_elements_text(v_hosts) AS value
          UNION ALL SELECT p_host
        ) AS sorted_hosts;
    ELSE
      -- A reconfirmation never changes the host set. It must be an existing,
      -- stale *positive* grant, not a revoked host or a current approval.
      IF NOT (v_hosts ? p_host) THEN
        RAISE EXCEPTION 'reconfirmation requires existing host' USING ERRCODE='42501';
      END IF;
      SELECT action,source_revision
        INTO v_previous_action,v_previous_source_revision
        FROM vns.admin_source_host_audit
        WHERE host=p_host ORDER BY revision DESC LIMIT 1;
      IF v_previous_action IS DISTINCT FROM 'grant'
        OR v_previous_source_revision IS NULL
        OR v_previous_source_revision >= v_source_revision
      THEN RAISE EXCEPTION 'host reconfirmation not stale' USING ERRCODE='42501'; END IF;
    END IF;
  ELSE
    IF NOT v_hosts ? p_host THEN
      RAISE EXCEPTION 'host is not approved' USING ERRCODE='22023';
    END IF;
    SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]'::jsonb) INTO v_hosts
      FROM jsonb_array_elements_text(v_hosts) AS value WHERE value<>p_host;
  END IF;

  UPDATE vns.admin_source_host_approvals
    SET revision=p_expected+1,approved_hosts=v_hosts WHERE singleton=true;
  INSERT INTO vns.admin_source_host_audit(
    revision,source_revision,action,host,reason,editor_id,editor_username,
    editor_auth_version,approval_model
  ) VALUES(p_expected+1,p_source_revision,
    CASE WHEN p_action='renew' THEN 'grant' ELSE p_action END,
    p_host,p_reason,p_editor_id,v_name,p_auth_version,v_approval_model);
  RETURN true;
END;
$approval$;
COMMENT ON FUNCTION vns.admin_change_source_host_approval(bigint,bigint,text,text,text,uuid,integer)
  IS 'Personal host grant, revoke or explicit stale-grant reconfirmation with source-revision CAS, independent reviewer, append-only audit and unchanged host set.';
INSERT INTO vns.schema_migrations(version) VALUES('0062_host_reconfirmation');
COMMIT;
