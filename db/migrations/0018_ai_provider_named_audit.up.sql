-- P1-09 / 0018: personal-admin attribution foundation, disposable CI only.
-- NO runtime LOGIN, HTTP mount, productive migration, provider activation or real credentials.
BEGIN;

CREATE TABLE vns.ai_provider_named_config_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL REFERENCES vns.ai_provider_settings(provider) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('set_key','remove_key','set_model')),
  editor_id uuid NOT NULL REFERENCES vns.editor_accounts(id) ON DELETE RESTRICT,
  editor_username text NOT NULL CHECK (length(editor_username) BETWEEN 3 AND 32),
  editor_auth_version integer NOT NULL CHECK (editor_auth_version >= 0),
  database_login name NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ai_provider_named_events_by_editor
  ON vns.ai_provider_named_config_events(editor_id,recorded_at DESC);

CREATE TRIGGER reject_ai_provider_named_event_mutation
  BEFORE UPDATE OR DELETE ON vns.ai_provider_named_config_events
  FOR EACH ROW EXECUTE FUNCTION vns.prevent_review_event_mutation();
CREATE TRIGGER reject_ai_provider_named_event_truncate
  BEFORE TRUNCATE ON vns.ai_provider_named_config_events
  FOR EACH STATEMENT EXECUTE FUNCTION vns.prevent_review_event_mutation();

-- Only the NOLOGIN function owner may lock the named editor and write audit.
GRANT SELECT(id,username,role,active,auth_version), UPDATE(id)
  ON vns.editor_accounts TO vns_provider_config_executor;
GRANT INSERT ON vns.ai_provider_named_config_events TO vns_provider_config_executor;
GRANT SELECT ON vns.ai_provider_named_config_events TO vns_audit_reader;

CREATE FUNCTION vns.admin_mutate_ai_provider_as_editor(
  p_provider text, p_action text, p_model text,
  p_nonce bytea, p_ciphertext bytea, p_tag bytea,
  p_editor_id uuid, p_auth_version integer
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, vns, pg_temp
AS $named$
DECLARE
  v_username text;
BEGIN
  IF p_editor_id IS NULL OR p_auth_version IS NULL
     OR p_auth_version < 0 THEN
    RAISE EXCEPTION 'named admin identity unavailable' USING ERRCODE='42501';
  END IF;
  -- Lock through the provider mutation; role/password/active revocation
  -- cannot race this audited transaction. Never trust request-supplied name.
  SELECT username INTO v_username
    FROM vns.editor_accounts
   WHERE id=p_editor_id AND role='admin' AND active=true
     AND auth_version=p_auth_version
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'named admin identity unavailable' USING ERRCODE='42501';
  END IF;

  -- Reuse the already audited, allowlisted, disabled-provider mutation.
  -- An intentional legacy shared-context event is emitted alongside this
  -- linked-in-transaction named event; neither can commit alone.
  PERFORM vns.admin_mutate_ai_provider(
    p_provider,p_action,p_model,p_nonce,p_ciphertext,p_tag);

  INSERT INTO vns.ai_provider_named_config_events
    (provider,action,editor_id,editor_username,editor_auth_version,database_login)
  VALUES(p_provider,p_action,p_editor_id,v_username,p_auth_version,session_user);
END;
$named$;

REVOKE ALL ON FUNCTION vns.admin_mutate_ai_provider_as_editor(
  text,text,text,bytea,bytea,bytea,uuid,integer) FROM PUBLIC;
ALTER FUNCTION vns.admin_mutate_ai_provider_as_editor(
  text,text,text,bytea,bytea,bytea,uuid,integer)
  OWNER TO vns_provider_config_executor;
GRANT EXECUTE ON FUNCTION vns.admin_mutate_ai_provider_as_editor(
  text,text,text,bytea,bytea,bytea,uuid,integer)
  TO vns_provider_config_writer;

-- An ordinary provider writer must not use the shared-admin write path
-- to bypass required named session evidence after this migration.
REVOKE EXECUTE ON FUNCTION vns.admin_mutate_ai_provider(
  text,text,text,bytea,bytea,bytea) FROM vns_provider_config_writer;

COMMENT ON TABLE vns.ai_provider_named_config_events IS
 'CI-only append-only personally attributed provider changes; assertions require trusted named editor session upstream.';
COMMENT ON FUNCTION vns.admin_mutate_ai_provider_as_editor(
  text,text,text,bytea,bytea,bytea,uuid,integer) IS
 'CI-only guarded mutation with locked active admin/auth_version; caller must authenticate identity upstream. Not live.';

INSERT INTO vns.schema_migrations(version)
VALUES ('0018_ai_provider_named_audit');
COMMIT;
