-- P1-05 / 0001 down: destructive by design. Never execute on production data.
-- No CASCADE: fail rather than dropping external/unknown dependent objects.
BEGIN;

DELETE FROM vns.schema_migrations WHERE version = '0001_editorial_core';

DROP TABLE vns.uploads;
DROP TABLE vns.approvals;
DROP TABLE vns.costs;
DROP TABLE vns.videos;
DROP TABLE vns.jobs;
DROP TABLE vns.scripts;
DROP TABLE vns.assets;
DROP TABLE vns.claims;
DROP TABLE vns.stories;
DROP TABLE vns.licenses;
DROP TABLE vns.sources;

DROP FUNCTION vns.touch_updated_at();
DROP TABLE vns.schema_migrations;
DROP SCHEMA vns;

COMMIT;
