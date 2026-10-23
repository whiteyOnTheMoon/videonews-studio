-- P1-05 destructive rollback. Run only on disposable/test databases or after backup.
BEGIN;
DROP TABLE IF EXISTS uploads;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS costs;
DROP TABLE IF EXISTS videos;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS scripts;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS licenses;
DROP TABLE IF EXISTS claims;
DROP TABLE IF EXISTS stories;
DROP TABLE IF EXISTS sources;
DROP FUNCTION IF EXISTS vns_set_updated_at();
COMMIT;
