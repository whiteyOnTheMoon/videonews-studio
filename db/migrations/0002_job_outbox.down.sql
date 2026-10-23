-- P1-07 / 0002 down. Destructive. NEVER run against production.
BEGIN;

DELETE FROM vns.schema_migrations WHERE version = '0002_job_outbox';
DROP FUNCTION vns.create_job_with_outbox(text, text, uuid, integer);
DROP TABLE vns.job_outbox;

COMMIT;
