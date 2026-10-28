-- CI ONLY: never delete real dispatch claims.
BEGIN;
DROP FUNCTION vns.claim_provider_live_dispatch(uuid);
DROP TABLE vns.provider_live_dispatch_claims;
DELETE FROM vns.schema_migrations
 WHERE version='0039_provider_one_shot_dispatch_claim';
COMMIT;
