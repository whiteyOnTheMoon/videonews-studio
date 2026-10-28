-- Offline rollback only. Never delete verified production audit history.
BEGIN;
DROP FUNCTION vns.admin_review_live_provider_fx_as_editor(
 uuid,integer,bigint,timestamptz,text);
DROP FUNCTION vns.admin_review_live_provider_price_as_editor(
 uuid,integer,text,text,text,bigint,bigint,bigint,timestamptz,text);
DROP FUNCTION vns.admin_assert_live_price_reviewer(uuid,integer);
DROP TABLE vns.provider_live_named_price_reviews;
REVOKE SELECT, INSERT ON vns.provider_live_price_snapshots,
 vns.provider_live_fx_snapshots FROM vns_provider_config_executor;
DELETE FROM vns.schema_migrations WHERE version='0041_named_live_price_fx_reviews';
COMMIT;
