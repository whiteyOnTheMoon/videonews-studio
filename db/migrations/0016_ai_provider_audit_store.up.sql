-- P1-09 / 0016: offline-only, atomic and audited administration contract.
-- NO LOGIN, NO MEMBERSHIP and NO VPS rollout. Never apply without separate approval.
BEGIN;

CREATE ROLE vns_provider_config_executor
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE vns_provider_config_writer
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

CREATE TABLE vns.ai_provider_config_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL REFERENCES vns.ai_provider_settings(provider) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('set_key','remove_key','set_model')),
  actor_context text NOT NULL DEFAULT 'shared-admin-session'
    CHECK (actor_context = 'shared-admin-session'),
  database_login name NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ai_provider_events_by_provider
  ON vns.ai_provider_config_events(provider,recorded_at DESC);

CREATE TRIGGER reject_ai_provider_config_event_mutation
  BEFORE UPDATE OR DELETE ON vns.ai_provider_config_events
  FOR EACH ROW EXECUTE FUNCTION vns.prevent_review_event_mutation();
CREATE TRIGGER reject_ai_provider_config_event_truncate
  BEFORE TRUNCATE ON vns.ai_provider_config_events
  FOR EACH STATEMENT EXECUTE FUNCTION vns.prevent_review_event_mutation();

GRANT USAGE ON SCHEMA vns
  TO vns_provider_config_executor, vns_provider_config_writer;
GRANT SELECT, UPDATE(selected_model,updated_at)
  ON vns.ai_provider_settings TO vns_provider_config_executor;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON vns.ai_provider_sealed_credentials TO vns_provider_config_executor;
GRANT INSERT ON vns.ai_provider_config_events TO vns_provider_config_executor;
-- The writer has zero direct table or event privileges and no LOGIN.

CREATE FUNCTION vns.admin_list_ai_providers()
RETURNS TABLE(provider text, "selectedModel" text, configured boolean)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, vns, pg_temp
AS $list$
 SELECT s.provider, s.selected_model, (c.provider IS NOT NULL)
 FROM vns.ai_provider_settings AS s
 LEFT JOIN vns.ai_provider_sealed_credentials AS c ON c.provider=s.provider
 ORDER BY s.provider
$list$;

CREATE FUNCTION vns.admin_mutate_ai_provider(
  p_provider text, p_action text, p_model text,
  p_nonce bytea, p_ciphertext bytea, p_tag bytea
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, vns, pg_temp
AS $mutate$
DECLARE
  v_stored_model text;
  v_allowed boolean;
BEGIN
  IF p_provider IS NULL OR p_action IS NULL
     OR p_provider NOT IN ('openai','google_gemini')
     OR p_action NOT IN ('set_key','remove_key','set_model') THEN
    RAISE EXCEPTION 'invalid provider mutation' USING ERRCODE='22023';
  END IF;

  -- Lock the provider row: rotations, removals and metadata changes
  -- for this provider must be serialized in this same transaction.
  SELECT selected_model INTO v_stored_model
  FROM vns.ai_provider_settings
  WHERE provider=p_provider AND enabled=false FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider unavailable or active' USING ERRCODE='22023';
  END IF;

  IF p_action='set_key' THEN
    IF p_model IS NOT NULL OR p_nonce IS NULL OR p_ciphertext IS NULL
       OR p_tag IS NULL OR octet_length(p_nonce)<>12
       OR octet_length(p_ciphertext) NOT BETWEEN 12 AND 512
       OR octet_length(p_tag)<>16 THEN
      RAISE EXCEPTION 'invalid sealed key envelope' USING ERRCODE='22023';
    END IF;
    -- No plaintext ever enters PostgreSQL. Audited upsert and event
    -- are in one statement transaction; any failure rolls all back.
    INSERT INTO vns.ai_provider_sealed_credentials
      (provider,format_version,nonce,ciphertext,auth_tag,changed_at)
    VALUES(p_provider,1,p_nonce,p_ciphertext,p_tag,clock_timestamp())
    ON CONFLICT(provider) DO UPDATE SET
      format_version=1, nonce=EXCLUDED.nonce,
      ciphertext=EXCLUDED.ciphertext,auth_tag=EXCLUDED.auth_tag,
      changed_at=clock_timestamp();
  ELSIF p_action='remove_key' THEN
    IF p_model IS NOT NULL OR p_nonce IS NOT NULL OR p_ciphertext IS NOT NULL
       OR p_tag IS NOT NULL THEN
      RAISE EXCEPTION 'invalid key removal' USING ERRCODE='22023';
    END IF;
    DELETE FROM vns.ai_provider_sealed_credentials
    WHERE provider=p_provider;
  ELSE
    IF p_model IS NULL OR p_nonce IS NOT NULL OR p_ciphertext IS NOT NULL
       OR p_tag IS NOT NULL THEN
      RAISE EXCEPTION 'invalid model mutation' USING ERRCODE='22023';
    END IF;
    v_allowed :=
      (p_provider='openai' AND p_model IN ('gpt-6-luna','gpt-6.1-sol'))
      OR (p_provider='google_gemini' AND p_model='gemini-3.8-flash-tts');
    IF NOT COALESCE(v_allowed,false) THEN
      RAISE EXCEPTION 'model not allowlisted' USING ERRCODE='22023';
    END IF;
    UPDATE vns.ai_provider_settings
       SET selected_model=p_model,updated_at=clock_timestamp()
     WHERE provider=p_provider;
  END IF;

  -- Fixed, truthful attribution: the current shared admin session
  -- does not identify a specific human; do not fabricate user identity.
  INSERT INTO vns.ai_provider_config_events(provider,action,database_login)
    VALUES(p_provider,p_action,session_user);
END;
$mutate$;

REVOKE ALL ON FUNCTION vns.admin_list_ai_providers() FROM PUBLIC;
REVOKE ALL ON FUNCTION vns.admin_mutate_ai_provider(
  text,text,text,bytea,bytea,bytea
) FROM PUBLIC;
ALTER FUNCTION vns.admin_list_ai_providers()
  OWNER TO vns_provider_config_executor;
ALTER FUNCTION vns.admin_mutate_ai_provider(text,text,text,bytea,bytea,bytea)
  OWNER TO vns_provider_config_executor;
GRANT EXECUTE ON FUNCTION vns.admin_list_ai_providers()
  TO vns_provider_config_writer;
GRANT EXECUTE ON FUNCTION vns.admin_mutate_ai_provider(
  text,text,text,bytea,bytea,bytea
) TO vns_provider_config_writer;

COMMENT ON TABLE vns.ai_provider_config_events IS
  'Append-only synthetic provider settings audit; shared-admin-session is NOT personal attribution.';
COMMENT ON FUNCTION vns.admin_mutate_ai_provider(text,text,text,bytea,bytea,bytea) IS
  'CI-only credential envelope and model mutation. NOT connected to live API, keys, or billing.';

INSERT INTO vns.schema_migrations(version)
VALUES ('0016_ai_provider_audit_store');
COMMIT;
