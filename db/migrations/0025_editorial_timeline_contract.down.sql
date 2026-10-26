-- Disposable CI reversal ONLY.
BEGIN;
DROP FUNCTION vns.read_editorial_timeline(uuid,uuid,integer,integer);
DROP FUNCTION vns.append_editorial_timeline(uuid,text,uuid,integer,text,text,jsonb);
DELETE FROM vns.schema_migrations WHERE version='0025_editorial_timeline_contract';
COMMIT;
