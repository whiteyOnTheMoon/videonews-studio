-- P1-09 #230: remove direct runtime admission bypass.
-- The sole runtime entry requires an immutable named SQL approval and
-- commits that check and budget reservation in the same transaction.
BEGIN;
CREATE FUNCTION vns.reserve_authorized_provider_live_budget(
 p_job_id uuid,p_provider text,p_model text,p_request_id text,
 p_price_snapshot_id uuid,p_max_input integer,p_max_output integer,
 p_prompt_sha256 text
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $authorized$
DECLARE
 v_reservation uuid;
BEGIN
 IF p_prompt_sha256 IS NULL OR p_prompt_sha256 !~ '^[0-9a-f]{64}$'
    OR p_max_input IS NULL OR p_max_output IS NULL THEN
   RAISE EXCEPTION 'Provider budget authority unavailable' USING ERRCODE='42501';
 END IF;
 -- Serialize authorization with policy changes and other admission sessions.
 PERFORM 1 FROM vns.provider_live_budget_policy WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'Provider budget authority unavailable' USING ERRCODE='42501';
 END IF;
 IF vns.verify_provider_named_job_authorization(
     p_job_id,p_request_id,p_provider,p_model,p_price_snapshot_id,
     p_prompt_sha256,p_max_input,p_max_output) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'Provider job authorization denied' USING ERRCODE='42501';
 END IF;
 SELECT vns.reserve_provider_live_budget(
   p_job_id,p_provider,p_model,p_request_id,p_price_snapshot_id,
   p_max_input::bigint,p_max_output::bigint) INTO v_reservation;
 RETURN v_reservation;
END
$authorized$;

REVOKE ALL ON FUNCTION vns.reserve_authorized_provider_live_budget(
 uuid,text,text,text,uuid,integer,integer,text) FROM PUBLIC;
ALTER FUNCTION vns.reserve_authorized_provider_live_budget(
 uuid,text,text,text,uuid,integer,integer,text)
 OWNER TO vns_provider_usage_executor;
-- Direct unsigned SQL reservations are never allowed for the runtime writer.
REVOKE EXECUTE ON FUNCTION vns.reserve_provider_live_budget(
 uuid,text,text,text,uuid,bigint,bigint) FROM vns_provider_usage_writer;
GRANT EXECUTE ON FUNCTION vns.reserve_authorized_provider_live_budget(
 uuid,text,text,text,uuid,integer,integer,text)
 TO vns_provider_usage_writer;
INSERT INTO vns.schema_migrations(version)
 VALUES ('0045_atomic_named_provider_budget_gate');
COMMIT;
