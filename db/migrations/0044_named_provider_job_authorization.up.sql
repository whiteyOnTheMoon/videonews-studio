-- P1-09 / #230: personally attributed, immutable provider job intent.
-- No queue producer, runtime activation, API key, budget change or paid calls.
BEGIN;

CREATE TABLE vns.provider_named_job_authorizations (
 job_id uuid PRIMARY KEY REFERENCES vns.jobs(id) ON DELETE RESTRICT,
 request_id text NOT NULL UNIQUE CHECK(request_id ~ '^[A-Za-z0-9_-]{12,80}$'),
 provider text NOT NULL CHECK(provider IN ('openai','google_gemini')),
 model text NOT NULL CHECK(model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
 price_snapshot_id uuid NOT NULL REFERENCES vns.provider_live_price_snapshots(id),
 prompt_sha256 text NOT NULL CHECK(prompt_sha256 ~ '^[0-9a-f]{64}$'),
 max_input_tokens integer NOT NULL CHECK(max_input_tokens BETWEEN 1 AND 32768),
 max_output_tokens integer NOT NULL CHECK(max_output_tokens BETWEEN 16 AND 4096),
 editor_id uuid NOT NULL REFERENCES vns.editor_accounts(id) ON DELETE RESTRICT,
 editor_username text NOT NULL,
 editor_auth_version integer NOT NULL CHECK(editor_auth_version>=0),
 database_login name NOT NULL,
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER reject_provider_named_job_authorization_change
 BEFORE UPDATE OR DELETE ON vns.provider_named_job_authorizations
 FOR EACH ROW EXECUTE FUNCTION vns.reject_provider_usage_change();
CREATE TRIGGER reject_provider_named_job_authorization_truncate
 BEFORE TRUNCATE ON vns.provider_named_job_authorizations
 FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_provider_usage_change();

CREATE TABLE vns.provider_named_job_outbox (
 job_id uuid PRIMARY KEY REFERENCES vns.provider_named_job_authorizations(job_id)
  ON DELETE RESTRICT,
 queue_name text NOT NULL DEFAULT 'vns-provider-text'
  CHECK(queue_name='vns-provider-text'),
 delivery_state text NOT NULL DEFAULT 'pending'
  CHECK(delivery_state='pending'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER reject_provider_named_job_outbox_change
 BEFORE UPDATE OR DELETE ON vns.provider_named_job_outbox
 FOR EACH ROW EXECUTE FUNCTION vns.reject_provider_usage_change();
CREATE TRIGGER reject_provider_named_job_outbox_truncate
 BEFORE TRUNCATE ON vns.provider_named_job_outbox
 FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_provider_usage_change();

GRANT SELECT,INSERT ON vns.provider_named_job_authorizations
 TO vns_provider_config_executor;
GRANT SELECT,INSERT ON vns.provider_named_job_outbox
 TO vns_provider_config_executor;
GRANT SELECT ON vns.provider_named_job_authorizations,
 vns.provider_named_job_outbox TO vns_provider_usage_executor;
GRANT SELECT(id,kind,max_attempts) ON vns.jobs
 TO vns_provider_usage_executor;
GRANT SELECT(id,role,active,auth_version) ON vns.editor_accounts
 TO vns_provider_usage_executor;
GRANT SELECT ON vns.provider_named_job_authorizations,
 vns.provider_named_job_outbox TO vns_audit_reader;
GRANT SELECT(id,kind,status,max_attempts) ON vns.jobs
 TO vns_provider_config_executor;
GRANT SELECT ON vns.provider_live_named_price_reviews
 TO vns_provider_config_executor;

CREATE FUNCTION vns.admin_authorize_provider_job_as_editor(
 p_editor_id uuid,p_auth_version integer,p_job_id uuid,
 p_request_id text,p_provider text,p_model text,p_price_id uuid,
 p_prompt_sha256 text,p_max_input integer,p_max_output integer
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $authorize$
DECLARE v_name text; v_now timestamptz:=clock_timestamp();
BEGIN
 v_name:=vns.admin_assert_live_price_reviewer(p_editor_id,p_auth_version);
 IF p_job_id IS NULL OR p_request_id IS NULL
    OR p_request_id !~ '^[A-Za-z0-9_-]{12,80}$'
    OR p_provider NOT IN ('openai','google_gemini')
    OR p_model IS NULL OR p_model !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
    OR p_price_id IS NULL
    OR p_prompt_sha256 IS NULL OR p_prompt_sha256 !~ '^[0-9a-f]{64}$'
    OR p_max_input NOT BETWEEN 1 AND 32768
    OR p_max_output NOT BETWEEN 16 AND 4096
 THEN RAISE EXCEPTION 'Provider job authorization invalid' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(
    SELECT 1 FROM vns.jobs j
    WHERE j.id=p_job_id AND j.kind='script' AND j.status='pending'
      AND j.max_attempts=1
 ) OR NOT EXISTS(
    SELECT 1 FROM vns.provider_live_price_snapshots p
    JOIN vns.provider_live_named_price_reviews review
      ON review.snapshot_id=p.id AND review.kind='model_price'
    JOIN vns.editor_accounts reviewer ON reviewer.id=review.editor_id
    WHERE p.id=p_price_id AND p.provider=p_provider AND p.model=p_model
      AND p.expires_at>v_now
      AND reviewer.role='admin' AND reviewer.active
      AND reviewer.auth_version=review.editor_auth_version
 ) OR NOT EXISTS(
    SELECT 1 FROM vns.ai_provider_settings config
    WHERE config.provider=p_provider AND config.selected_model=p_model
      AND config.enabled=false
 ) THEN
    RAISE EXCEPTION 'Provider job authorization unavailable' USING ERRCODE='42501';
 END IF;
 INSERT INTO vns.provider_named_job_authorizations(
   job_id,request_id,provider,model,price_snapshot_id,prompt_sha256,
   max_input_tokens,max_output_tokens,editor_id,editor_username,
   editor_auth_version,database_login
 ) VALUES(
   p_job_id,p_request_id,p_provider,p_model,p_price_id,p_prompt_sha256,
   p_max_input,p_max_output,p_editor_id,v_name,p_auth_version,session_user
 );
 INSERT INTO vns.provider_named_job_outbox(job_id) VALUES(p_job_id);
 RETURN p_job_id;
END;
$authorize$;

CREATE FUNCTION vns.verify_provider_named_job_authorization(
 p_job_id uuid,p_request_id text,p_provider text,p_model text,p_price_id uuid,
 p_prompt_sha256 text,p_max_input integer,p_max_output integer
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $verify$
 SELECT EXISTS(
  SELECT 1 FROM vns.provider_named_job_authorizations a
  JOIN vns.provider_named_job_outbox o ON o.job_id=a.job_id
  JOIN vns.editor_accounts actor ON actor.id=a.editor_id
  JOIN vns.jobs j ON j.id=a.job_id
  WHERE a.job_id=p_job_id AND a.request_id=p_request_id
    AND a.provider=p_provider AND a.model=p_model
    AND a.price_snapshot_id=p_price_id AND a.prompt_sha256=p_prompt_sha256
    AND a.max_input_tokens=p_max_input AND a.max_output_tokens=p_max_output
    AND actor.role='admin' AND actor.active
    AND actor.auth_version=a.editor_auth_version
    AND j.kind='script' AND j.max_attempts=1
    AND o.queue_name='vns-provider-text' AND o.delivery_state='pending'
 );
$verify$;

REVOKE ALL ON FUNCTION vns.admin_authorize_provider_job_as_editor(
 uuid,integer,uuid,text,text,text,uuid,text,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION vns.verify_provider_named_job_authorization(
 uuid,text,text,text,uuid,text,integer,integer) FROM PUBLIC;
ALTER FUNCTION vns.admin_authorize_provider_job_as_editor(
 uuid,integer,uuid,text,text,text,uuid,text,integer,integer)
 OWNER TO vns_provider_config_executor;
ALTER FUNCTION vns.verify_provider_named_job_authorization(
 uuid,text,text,text,uuid,text,integer,integer)
 OWNER TO vns_provider_usage_executor;
GRANT EXECUTE ON FUNCTION vns.admin_authorize_provider_job_as_editor(
 uuid,integer,uuid,text,text,text,uuid,text,integer,integer)
 TO vns_provider_config_writer;
GRANT EXECUTE ON FUNCTION vns.verify_provider_named_job_authorization(
 uuid,text,text,text,uuid,text,integer,integer)
 TO vns_provider_usage_writer;
INSERT INTO vns.schema_migrations(version)
 VALUES('0044_named_provider_job_authorization');
COMMIT;
