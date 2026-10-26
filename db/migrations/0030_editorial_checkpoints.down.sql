-- Disposable CI rollback only. Never delete a production editorial audit ledger.
BEGIN;
DROP FUNCTION vns.named_read_editorial_checkpoints(uuid,integer,integer);
DROP FUNCTION vns.named_append_editorial_checkpoint(uuid,integer,text,text,text,jsonb,integer);
REVOKE SELECT,INSERT ON vns.editorial_checkpoint_log FROM vns_p2_named_executor;
DROP TABLE vns.editorial_checkpoint_log;
DELETE FROM vns.schema_migrations WHERE version='0030_editorial_checkpoints';
COMMIT;
