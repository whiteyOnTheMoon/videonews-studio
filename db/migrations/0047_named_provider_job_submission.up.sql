-- P1-09: a personally authorized provider request is one atomic SQL unit.
-- No Redis publication, budget enablement or external provider transport.
BEGIN;

GRANT INSERT(kind,idempotency_key,max_attempts) ON vns.jobs
 TO vns_provider_config_executor;
GRANT SELECT(idempotency_key) ON vns.jobs TO vns_provider_config_executor;

CREATE FUNCTION vns.admin_create_sealed_provider_job_as_editor(
 p_editor_id uuid,p_auth_version integer,p_idempotency_key text,
 p_request_id text,p_provider text,p_model text,p_price_id uuid,
 p_prompt_sha256 text,p_max_input integer,p_max_output integer,
 p_iv_base64 text,p_tag_base64 text,p_ciphertext_base64 text
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $create$
DECLARE
 v_job_id uuid;
BEGIN
 -- Personal identity must be current even for a repeated request ID.
 PERFORM vns.admin_assert_live_price_reviewer(p_editor_id,p_auth_version);
 IF p_idempotency_key IS NULL
    OR p_idempotency_key !~ '^[A-Za-z0-9_-]{24,80}$' THEN
  RAISE EXCEPTION 'Provider job submission invalid' USING ERRCODE='22023';
 END IF;

 -- The idempotency key cannot be reused to mutate personal authority or
 -- change the intended model, price, prompt digest or token bounds.
 SELECT j.id INTO v_job_id
   FROM vns.jobs j WHERE j.idempotency_key=p_idempotency_key;
 IF v_job_id IS NOT NULL THEN
   IF NOT EXISTS (
    SELECT 1
    FROM vns.provider_named_job_authorizations a
    JOIN vns.provider_named_job_sealed_prompts sealed ON sealed.job_id=a.job_id
    JOIN vns.provider_named_job_outbox outbox ON outbox.job_id=a.job_id
    JOIN vns.jobs j ON j.id=a.job_id
    WHERE a.job_id=v_job_id
      AND a.editor_id=p_editor_id AND a.editor_auth_version=p_auth_version
      AND a.request_id=p_request_id AND a.provider=p_provider
      AND a.model=p_model AND a.price_snapshot_id=p_price_id
      AND a.prompt_sha256=p_prompt_sha256
      AND a.max_input_tokens=p_max_input AND a.max_output_tokens=p_max_output
      AND sealed.prompt_sha256=p_prompt_sha256
      AND j.kind='script' AND j.max_attempts=1
      AND outbox.queue_name='vns-provider-text'
   ) THEN
     RAISE EXCEPTION 'Provider job idempotency conflict' USING ERRCODE='22023';
   END IF;
   -- Return only the already-created immutable approval, never re-enqueue.
   RETURN v_job_id;
 END IF;

 INSERT INTO vns.jobs(kind,idempotency_key,max_attempts)
 VALUES ('script',p_idempotency_key,1)
 ON CONFLICT(idempotency_key) DO NOTHING RETURNING id INTO v_job_id;
 IF v_job_id IS NULL THEN
   RAISE EXCEPTION 'Provider job submission retry required' USING ERRCODE='40001';
 END IF;

 -- The inner security definer locks and checks personal editor identity,
 -- reviewed price, selected disabled model and cryptographic envelope shape.
 -- Any failure rolls back the new job and all three related records.
 PERFORM vns.admin_authorize_sealed_provider_job_as_editor(
   p_editor_id,p_auth_version,v_job_id,p_request_id,p_provider,p_model,
   p_price_id,p_prompt_sha256,p_max_input,p_max_output,
   p_iv_base64,p_tag_base64,p_ciphertext_base64);
 RETURN v_job_id;
END;
$create$;
REVOKE ALL ON FUNCTION vns.admin_create_sealed_provider_job_as_editor(
 uuid,integer,text,text,text,text,uuid,text,integer,integer,text,text,text)
 FROM PUBLIC;
ALTER FUNCTION vns.admin_create_sealed_provider_job_as_editor(
 uuid,integer,text,text,text,text,uuid,text,integer,integer,text,text,text)
 OWNER TO vns_provider_config_executor;
GRANT EXECUTE ON FUNCTION vns.admin_create_sealed_provider_job_as_editor(
 uuid,integer,text,text,text,text,uuid,text,integer,integer,text,text,text)
 TO vns_provider_config_writer;
-- The application must not be able to supply arbitrary preexisting job IDs.
REVOKE EXECUTE ON FUNCTION vns.admin_authorize_sealed_provider_job_as_editor(
 uuid,integer,uuid,text,text,text,uuid,text,integer,integer,text,text,text)
 FROM vns_provider_config_writer;

INSERT INTO vns.schema_migrations(version)
 VALUES('0047_named_provider_job_submission');
COMMIT;
