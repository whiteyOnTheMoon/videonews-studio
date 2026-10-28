-- P1-09: persist only authenticated ciphertext alongside a named authorization.
-- No plaintext prompt column, Redis side effects, secret material, or enablement.
BEGIN;
CREATE TABLE vns.provider_named_job_sealed_prompts (
 job_id uuid PRIMARY KEY REFERENCES vns.provider_named_job_authorizations(job_id)
   ON DELETE RESTRICT,
 envelope_version smallint NOT NULL DEFAULT 1 CHECK(envelope_version=1),
 iv_base64 text NOT NULL CHECK(iv_base64 ~ '^[A-Za-z0-9+/]{16}$'),
 tag_base64 text NOT NULL CHECK(tag_base64 ~ '^[A-Za-z0-9+/]{22}==$'),
 ciphertext_base64 text NOT NULL
   CHECK(length(ciphertext_base64) BETWEEN 4 AND 43692
     AND ciphertext_base64 ~ '^[A-Za-z0-9+/]+={0,2}$'),
 prompt_sha256 text NOT NULL CHECK(prompt_sha256 ~ '^[0-9a-f]{64}$'),
 stored_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER reject_named_sealed_prompt_change
 BEFORE UPDATE OR DELETE ON vns.provider_named_job_sealed_prompts
 FOR EACH ROW EXECUTE FUNCTION vns.reject_provider_usage_change();
CREATE TRIGGER reject_named_sealed_prompt_truncate
 BEFORE TRUNCATE ON vns.provider_named_job_sealed_prompts
 FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_provider_usage_change();

GRANT INSERT ON vns.provider_named_job_sealed_prompts TO vns_provider_config_executor;
GRANT SELECT(job_id,prompt_sha256) ON vns.provider_named_job_sealed_prompts
 TO vns_provider_config_executor;
-- Deliberately no worker, Redis, audit reader or PUBLIC table access.
-- A future dedicated producer will require an audited, separate read identity.

CREATE FUNCTION vns.admin_authorize_sealed_provider_job_as_editor(
 p_editor_id uuid,p_auth_version integer,p_job_id uuid,
 p_request_id text,p_provider text,p_model text,p_price_id uuid,
 p_prompt_sha256 text,p_max_input integer,p_max_output integer,
 p_iv_base64 text,p_tag_base64 text,p_ciphertext_base64 text
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $authorize$
DECLARE v_job_id uuid;
BEGIN
 IF p_iv_base64 IS NULL OR p_iv_base64 !~ '^[A-Za-z0-9+/]{16}$'
  OR p_tag_base64 IS NULL OR p_tag_base64 !~ '^[A-Za-z0-9+/]{22}==$'
  OR p_ciphertext_base64 IS NULL
  OR length(p_ciphertext_base64) NOT BETWEEN 4 AND 43692
  OR p_ciphertext_base64 !~ '^[A-Za-z0-9+/]+={0,2}$'
  OR length(decode(p_iv_base64,'base64'))<>12
  OR length(decode(p_tag_base64,'base64'))<>16
  OR length(decode(p_ciphertext_base64,'base64')) NOT BETWEEN 1 AND 32768
 THEN
  RAISE EXCEPTION 'Sealed provider job unavailable' USING ERRCODE='22023';
 END IF;
 -- Existing named approval and outbox intent are committed atomically
 -- with ciphertext. Cryptographic authenticity is verified in application
 -- code with the separately held AES-GCM key, never with a database secret.
 v_job_id:=vns.admin_authorize_provider_job_as_editor(
  p_editor_id,p_auth_version,p_job_id,p_request_id,p_provider,p_model,
  p_price_id,p_prompt_sha256,p_max_input,p_max_output);
 INSERT INTO vns.provider_named_job_sealed_prompts(
  job_id,iv_base64,tag_base64,ciphertext_base64,prompt_sha256)
 VALUES(v_job_id,p_iv_base64,p_tag_base64,p_ciphertext_base64,p_prompt_sha256);
 RETURN v_job_id;
END;
$authorize$;
REVOKE ALL ON FUNCTION vns.admin_authorize_sealed_provider_job_as_editor(
 uuid,integer,uuid,text,text,text,uuid,text,integer,integer,text,text,text)
 FROM PUBLIC;
ALTER FUNCTION vns.admin_authorize_sealed_provider_job_as_editor(
 uuid,integer,uuid,text,text,text,uuid,text,integer,integer,text,text,text)
 OWNER TO vns_provider_config_executor;
GRANT EXECUTE ON FUNCTION vns.admin_authorize_sealed_provider_job_as_editor(
 uuid,integer,uuid,text,text,text,uuid,text,integer,integer,text,text,text)
 TO vns_provider_config_writer;

-- An operator must not be able to create new unrecoverable approvals.
REVOKE EXECUTE ON FUNCTION vns.admin_authorize_provider_job_as_editor(
 uuid,integer,uuid,text,text,text,uuid,text,integer,integer)
 FROM vns_provider_config_writer;
INSERT INTO vns.schema_migrations(version)
 VALUES('0046_provider_named_sealed_outbox');
COMMIT;
