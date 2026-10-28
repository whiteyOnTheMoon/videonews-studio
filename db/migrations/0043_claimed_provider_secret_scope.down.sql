-- Disposable CI rollback only; never erase production read audit.
BEGIN;
DROP FUNCTION vns.claimed_provider_sealed_key(uuid,text);
DROP TABLE vns.provider_live_credential_reads;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA vns FROM vns_provider_secret_reader;
REVOKE USAGE ON SCHEMA vns FROM vns_provider_secret_reader;
DROP ROLE vns_provider_secret_reader;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA vns FROM vns_provider_secret_executor;
REVOKE USAGE ON SCHEMA vns FROM vns_provider_secret_executor;
DROP ROLE vns_provider_secret_executor;
DELETE FROM vns.schema_migrations
 WHERE version='0043_claimed_provider_secret_scope';
COMMIT;
