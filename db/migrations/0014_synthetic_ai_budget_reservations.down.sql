-- Destructive disposable-CI-only rollback. NEVER run on VPS.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version='0014_synthetic_ai_budget_reservations';
DROP FUNCTION vns.reserve_synthetic_ai_budget(uuid,text,text,text,integer,integer,date);
DROP TRIGGER synthetic_ai_reservations_no_change ON vns.synthetic_ai_reservations;
DROP TRIGGER synthetic_ai_reservations_no_truncate ON vns.synthetic_ai_reservations;
DROP TRIGGER synthetic_ai_budget_days_no_delete ON vns.synthetic_ai_budget_days;
DROP TRIGGER synthetic_ai_budget_days_no_truncate ON vns.synthetic_ai_budget_days;
DROP FUNCTION vns.reject_synthetic_budget_mutation();
DROP TABLE vns.synthetic_ai_reservations;
DROP TABLE vns.synthetic_ai_budget_days;
COMMIT;
