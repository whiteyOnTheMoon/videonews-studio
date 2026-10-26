-- Disposable CI rollback only; production audit data must not be deleted.
BEGIN;
DROP FUNCTION vns.commit_editorial_profiles(bigint,jsonb,uuid,integer);
DROP TABLE vns.editorial_profile_audit;
DROP TABLE vns.editorial_profile_registry;
DELETE FROM vns.schema_migrations WHERE version='0027_editorial_profiles';
COMMIT;
