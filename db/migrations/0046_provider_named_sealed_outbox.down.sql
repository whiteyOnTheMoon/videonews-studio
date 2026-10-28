BEGIN;
GRANT EXECUTE ON FUNCTION vns.admin_authorize_provider_job_as_editor(
 uuid,integer,uuid,text,text,text,uuid,text,integer,integer)
 TO vns_provider_config_writer;
REVOKE EXECUTE ON FUNCTION vns.admin_authorize_sealed_provider_job_as_editor(
 uuid,integer,uuid,text,text,text,uuid,text,integer,integer,text,text,text)
 FROM vns_provider_config_writer;
DROP FUNCTION vns.admin_authorize_sealed_provider_job_as_editor(
 uuid,integer,uuid,text,text,text,uuid,text,integer,integer,text,text,text);
DROP TABLE vns.provider_named_job_sealed_prompts;
DELETE FROM vns.schema_migrations WHERE version='0046_provider_named_sealed_outbox';
COMMIT;
