-- CI rollback only. Do not discard an active editorial audit ledger.
BEGIN;
DROP TABLE vns.editorial_timeline;
DROP FUNCTION vns.refuse_editorial_timeline_mutation();
DELETE FROM vns.schema_migrations WHERE version='0024_editorial_timeline';
COMMIT;
