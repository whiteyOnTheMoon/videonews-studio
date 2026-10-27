-- Disposable CI only. Never drop provider receipts on the VPS.
BEGIN;
DROP FUNCTION vns.record_provider_usage_evidence(
  uuid,text,text,text,text,text,bigint,bigint,bigint,bigint);
DROP TABLE vns.provider_usage_receipts;
DROP FUNCTION vns.reject_provider_usage_change();
REVOKE USAGE ON SCHEMA vns FROM vns_provider_usage_executor,vns_provider_usage_writer;
DROP ROLE vns_provider_usage_writer;
DROP ROLE vns_provider_usage_executor;
DELETE FROM vns.schema_migrations WHERE version='0036_provider_usage_evidence';
COMMIT;
