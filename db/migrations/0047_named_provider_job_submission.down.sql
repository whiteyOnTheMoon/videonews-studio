BEGIN;
REVOKE EXECUTE ON FUNCTION vns.admin_create_sealed_provider_job_as_editor(
 uuid,integer,text,text,text,text,uuid,text,integer,integer,text,text,text)
 FROM vns_provider_config_writer;
DROP FUNCTION vns.admin_create_sealed_provider_job_as_editor(
 uuid,integer,text,text,text,text,uuid,text,integer,integer,text,text,text);
GRANT EXECUTE ON FUNCTION vns.admin_authorize_sealed_provider_job_as_editor(
 uuid,integer,uuid,text,text,text,uuid,text,integer,integer,text,text,text)
 TO vns_provider_config_writer;
REVOKE INSERT(kind,idempotency_key,max_attempts) ON vns.jobs
 FROM vns_provider_config_executor;
REVOKE SELECT(idempotency_key) ON vns.jobs FROM vns_provider_config_executor;
DELETE FROM vns.schema_migrations WHERE version='0047_named_provider_job_submission';
COMMIT;
