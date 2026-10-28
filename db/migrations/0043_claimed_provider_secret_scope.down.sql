-- Disposable CI rollback only; never erase production read audit.
BEGIN;
DROP FUNCTION vns.claimed_provider_sealed_key(uuid,text);
DROP TABLE vns.provider_live_credential_reads;
DROP ROLE vns_provider_secret_reader;
DROP ROLE vns_provider_secret_executor;
DELETE FROM vns.schema_migrations
 WHERE version='0043_claimed_provider_secret_scope';
COMMIT;
