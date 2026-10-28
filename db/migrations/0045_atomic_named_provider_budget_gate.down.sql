BEGIN;
REVOKE EXECUTE ON FUNCTION vns.reserve_authorized_provider_live_budget(
 uuid,text,text,text,uuid,integer,integer,text)
 FROM vns_provider_usage_writer;
DROP FUNCTION vns.reserve_authorized_provider_live_budget(
 uuid,text,text,text,uuid,integer,integer,text);
GRANT EXECUTE ON FUNCTION vns.reserve_provider_live_budget(
 uuid,text,text,text,uuid,bigint,bigint)
 TO vns_provider_usage_writer;
DELETE FROM vns.schema_migrations WHERE version='0045_atomic_named_provider_budget_gate';
COMMIT;
