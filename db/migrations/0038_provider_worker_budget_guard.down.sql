-- Disposable CI only. NEVER erase production budget faults.
BEGIN;
DROP FUNCTION vns.halt_provider_live_budget(uuid,text);
DROP FUNCTION vns.get_provider_live_reservation(uuid);
DROP TABLE vns.provider_live_worker_faults;
DELETE FROM vns.schema_migrations WHERE version='0038_provider_worker_budget_guard';
COMMIT;
