-- Offline-only, guarded rollback. Never discard new provenance or usage data.
BEGIN;

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM vns.assets
    WHERE origin_url IS NOT NULL OR creator IS NOT NULL
      OR license_url IS NOT NULL OR license_snapshot IS NOT NULL
      OR content_sha256 IS NOT NULL OR rights_flags<>'{}'::jsonb
  ) OR EXISTS (SELECT 1 FROM vns.asset_uses) THEN
    RAISE EXCEPTION 'P3-01 rollback refused: asset provenance or usage exists'
      USING ERRCODE='23514';
  END IF;
END;
$guard$;

DROP VIEW vns.asset_rights_readiness;
DROP TRIGGER validate_asset_usage_story ON vns.asset_uses;
DROP FUNCTION vns.validate_asset_usage_story();
DROP TABLE vns.asset_uses;
DROP TRIGGER protect_asset_provenance ON vns.assets;
DROP FUNCTION vns.protect_asset_provenance();

ALTER TABLE vns.assets
  DROP CONSTRAINT assets_p3_clearance_evidence_required,
  DROP CONSTRAINT assets_p3_rights_flags_object,
  DROP CONSTRAINT assets_p3_sha256_format,
  DROP CONSTRAINT assets_p3_snapshot_object,
  DROP CONSTRAINT assets_p3_license_url_format,
  DROP CONSTRAINT assets_p3_creator_format,
  DROP CONSTRAINT assets_p3_origin_url_format,
  DROP COLUMN rights_flags,
  DROP COLUMN content_sha256,
  DROP COLUMN license_snapshot,
  DROP COLUMN license_url,
  DROP COLUMN creator,
  DROP COLUMN origin_url;

DELETE FROM vns.schema_migrations
WHERE version='0064_asset_provenance_catalog';
COMMIT;
