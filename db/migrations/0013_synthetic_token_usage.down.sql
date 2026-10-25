-- Destructive CI-only rollback; never use on real usage or production.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version='0013_synthetic_token_usage';
DROP FUNCTION vns.record_synthetic_token_usage(
  uuid,text,text,text,bigint,bigint,bigint,bigint
);
DROP TRIGGER reject_token_usage_update_delete ON vns.job_token_usage;
DROP TRIGGER reject_token_usage_truncate ON vns.job_token_usage;
DROP FUNCTION vns.reject_token_usage_mutation();
DROP TABLE vns.job_token_usage;
COMMIT;
