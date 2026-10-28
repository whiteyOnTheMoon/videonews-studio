-- P1-09: least-privilege ciphertext handoff and append-only Redis receipt.
-- NO LOGIN credentials, producer process or billable transport activated.
BEGIN;
CREATE ROLE vns_provider_outbox_executor
 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE vns_provider_outbox_reader
 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
GRANT USAGE ON SCHEMA vns TO
 vns_provider_outbox_executor,vns_provider_outbox_reader;

CREATE TABLE vns.provider_named_job_delivery_receipts(
 job_id uuid PRIMARY KEY REFERENCES vns.provider_named_job_outbox(job_id) ON DELETE RESTRICT,
 queue_job_id uuid NOT NULL CHECK(queue_job_id=job_id),
 queue_name text NOT NULL DEFAULT 'vns-provider-text' CHECK(queue_name='vns-provider-text'),
 database_login name NOT NULL,
 published_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER reject_provider_job_delivery_receipt_change
 BEFORE UPDATE OR DELETE ON vns.provider_named_job_delivery_receipts
 FOR EACH ROW EXECUTE FUNCTION vns.reject_provider_usage_change();
CREATE TRIGGER reject_provider_job_delivery_receipt_truncate
 BEFORE TRUNCATE ON vns.provider_named_job_delivery_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_provider_usage_change();

GRANT SELECT ON vns.provider_named_job_authorizations,
 vns.provider_named_job_sealed_prompts,vns.provider_named_job_outbox,
 vns.provider_named_job_delivery_receipts
 TO vns_provider_outbox_executor;
GRANT SELECT(id,role,active,auth_version) ON vns.editor_accounts
 TO vns_provider_outbox_executor;
GRANT SELECT(id,kind,status,max_attempts) ON vns.jobs
 TO vns_provider_outbox_executor;
GRANT SELECT(id,provider,model,expires_at) ON vns.provider_live_price_snapshots
 TO vns_provider_outbox_executor;
GRANT INSERT ON vns.provider_named_job_delivery_receipts
 TO vns_provider_outbox_executor;
GRANT SELECT ON vns.provider_named_job_delivery_receipts TO vns_audit_reader;

CREATE FUNCTION vns.read_authorized_provider_outbox(p_limit integer)
RETURNS TABLE(
 job_id uuid, request_id text, provider text, model text,
 price_snapshot_id uuid, prompt_sha256 text,
 max_input_tokens integer, max_output_tokens integer,
 envelope_version smallint, iv_base64 text, tag_base64 text,
 ciphertext_base64 text
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $read$
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN
  RAISE EXCEPTION 'Provider outbox unavailable' USING ERRCODE='22023';
 END IF;
 RETURN QUERY SELECT a.job_id,a.request_id,a.provider,a.model,
   a.price_snapshot_id,a.prompt_sha256,a.max_input_tokens,a.max_output_tokens,
   s.envelope_version,s.iv_base64,s.tag_base64,s.ciphertext_base64
 FROM vns.provider_named_job_outbox o
 JOIN vns.provider_named_job_authorizations a ON a.job_id=o.job_id
 JOIN vns.provider_named_job_sealed_prompts s ON s.job_id=o.job_id
 JOIN vns.editor_accounts actor ON actor.id=a.editor_id
 JOIN vns.jobs j ON j.id=a.job_id
 JOIN vns.provider_live_price_snapshots price ON price.id=a.price_snapshot_id
 LEFT JOIN vns.provider_named_job_delivery_receipts receipt ON receipt.job_id=a.job_id
 WHERE o.queue_name='vns-provider-text' AND o.delivery_state='pending'
  AND receipt.job_id IS NULL
  AND actor.role='admin' AND actor.active AND actor.auth_version=a.editor_auth_version
  AND j.kind='script' AND j.status='pending' AND j.max_attempts=1
  AND price.provider=a.provider AND price.model=a.model
  AND price.expires_at>clock_timestamp()
  AND a.prompt_sha256=s.prompt_sha256
 ORDER BY o.recorded_at,a.job_id
 LIMIT p_limit;
END
$read$;

CREATE FUNCTION vns.ack_provider_outbox_delivery(p_job_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $ack$
BEGIN
 IF p_job_id IS NULL THEN
  RAISE EXCEPTION 'Provider outbox acknowledgement unavailable' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM vns.provider_named_job_outbox
   WHERE job_id=p_job_id AND queue_name='vns-provider-text'
   FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Provider outbox acknowledgement unavailable' USING ERRCODE='42501';
 END IF;
 INSERT INTO vns.provider_named_job_delivery_receipts(
   job_id,queue_job_id,database_login
 ) VALUES(p_job_id,p_job_id,session_user)
 ON CONFLICT(job_id) DO NOTHING;
 RETURN EXISTS(
   SELECT 1 FROM vns.provider_named_job_delivery_receipts
    WHERE job_id=p_job_id AND queue_job_id=p_job_id);
END
$ack$;

REVOKE ALL ON FUNCTION vns.read_authorized_provider_outbox(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION vns.ack_provider_outbox_delivery(uuid) FROM PUBLIC;
ALTER FUNCTION vns.read_authorized_provider_outbox(integer)
 OWNER TO vns_provider_outbox_executor;
ALTER FUNCTION vns.ack_provider_outbox_delivery(uuid)
 OWNER TO vns_provider_outbox_executor;
GRANT EXECUTE ON FUNCTION vns.read_authorized_provider_outbox(integer)
 TO vns_provider_outbox_reader;
GRANT EXECUTE ON FUNCTION vns.ack_provider_outbox_delivery(uuid)
 TO vns_provider_outbox_reader;
INSERT INTO vns.schema_migrations(version)
 VALUES('0048_provider_outbox_delivery_receipt');
COMMIT;
