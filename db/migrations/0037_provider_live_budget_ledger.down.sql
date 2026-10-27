-- CI-only rollback. NEVER remove a live reservation, receipt, or settlement.
BEGIN;
DROP FUNCTION vns.settle_provider_live_budget(uuid,uuid);
DROP FUNCTION vns.reserve_provider_live_budget(uuid,text,text,text,uuid,bigint,bigint);
DROP TABLE vns.provider_live_budget_incidents;
DROP TABLE vns.provider_live_settlements;
DROP TABLE vns.provider_live_reservations;
DROP TABLE vns.provider_live_budget_policy;
DROP TABLE vns.provider_live_price_snapshots;
DELETE FROM vns.schema_migrations WHERE version='0037_provider_live_budget_ledger';
COMMIT;
