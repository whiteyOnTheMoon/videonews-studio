-- Reverse only the dormant EUR gate. Never execute independently of version order.
BEGIN;
DROP TRIGGER check_live_provider_eur_dispatch
  ON vns.provider_live_dispatch_claims;
DROP TRIGGER check_live_provider_eur_reservation
  ON vns.provider_live_reservations;
DROP FUNCTION vns.guard_live_provider_eur_dispatch();
DROP FUNCTION vns.guard_live_provider_eur_reservation();
DROP TABLE vns.provider_live_eur_admissions;
DROP TABLE vns.provider_live_eur_policy;
DROP TABLE vns.provider_live_fx_snapshots;
DELETE FROM vns.schema_migrations WHERE version='0040_provider_offline_eur_fx_guard';
COMMIT;
