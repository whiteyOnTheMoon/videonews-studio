-- P3-01: dormant asset provenance catalog; no media downloads or render admission.
-- Existing rows and legacy "cleared" decisions are preserved, NOT grandfathered.
-- Never apply to a persistent VPS without separate operator/migration approval.
BEGIN;

ALTER TABLE vns.assets
  ADD COLUMN origin_url text,
  ADD COLUMN creator text,
  ADD COLUMN license_url text,
  ADD COLUMN license_snapshot jsonb,
  ADD COLUMN content_sha256 text,
  ADD COLUMN rights_flags jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE vns.assets
  ADD CONSTRAINT assets_p3_origin_url_format CHECK (
    origin_url IS NULL OR (
      length(origin_url) BETWEEN 12 AND 2048
      AND origin_url ~ '^https://[^[:space:]#]+$'
    )
  ),
  ADD CONSTRAINT assets_p3_creator_format CHECK (
    creator IS NULL OR (
      length(creator) BETWEEN 2 AND 200
      AND creator=btrim(creator) AND creator !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT assets_p3_license_url_format CHECK (
    license_url IS NULL OR (
      length(license_url) BETWEEN 12 AND 2048
      AND license_url ~ '^https://[^[:space:]#]+$'
    )
  ),
  ADD CONSTRAINT assets_p3_snapshot_object CHECK (
    license_snapshot IS NULL OR (
      jsonb_typeof(license_snapshot)='object'
      AND license_snapshot<>'{}'::jsonb
    )
  ),
  ADD CONSTRAINT assets_p3_sha256_format CHECK (
    content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT assets_p3_rights_flags_object CHECK (
    jsonb_typeof(rights_flags)='object'
  );

-- NOT VALID preserves historical rows, including legacy "cleared" records
-- without evidence; new INSERTs/UPDATEs must include provenance to be cleared.
-- Historical records remain BLOCKED by the readiness view below.
ALTER TABLE vns.assets
  ADD CONSTRAINT assets_p3_clearance_evidence_required CHECK (
    rights_status<>'cleared' OR (
      origin_url IS NOT NULL AND creator IS NOT NULL
      AND license_url IS NOT NULL AND license_snapshot IS NOT NULL
      AND content_sha256 IS NOT NULL
      AND attribution IS NOT NULL AND btrim(attribution)<>''
    )
  ) NOT VALID;

-- Once evidence is recorded it is immutable on this asset identity.
-- Corrections need a fresh asset identity; do not rewrite a license snapshot.
CREATE FUNCTION vns.protect_asset_provenance() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $provenance$
BEGIN
  IF (OLD.origin_url IS NOT NULL AND NEW.origin_url IS DISTINCT FROM OLD.origin_url)
    OR (OLD.creator IS NOT NULL AND NEW.creator IS DISTINCT FROM OLD.creator)
    OR (OLD.license_url IS NOT NULL AND NEW.license_url IS DISTINCT FROM OLD.license_url)
    OR (OLD.license_snapshot IS NOT NULL
        AND NEW.license_snapshot IS DISTINCT FROM OLD.license_snapshot)
    OR (OLD.content_sha256 IS NOT NULL
        AND NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256)
  THEN
    RAISE EXCEPTION 'asset provenance is immutable; create a new asset'
      USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$provenance$;

CREATE TRIGGER protect_asset_provenance
BEFORE UPDATE ON vns.assets
FOR EACH ROW EXECUTE FUNCTION vns.protect_asset_provenance();

-- Explicit actual use, rather than inferring media usage from story ownership.
CREATE TABLE vns.asset_uses (
  asset_id uuid NOT NULL REFERENCES vns.assets(id) ON DELETE RESTRICT,
  video_id uuid NOT NULL REFERENCES vns.videos(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(asset_id,video_id)
);

CREATE FUNCTION vns.validate_asset_usage_story() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $usage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vns.assets a
    JOIN vns.videos v ON v.id=NEW.video_id
    JOIN vns.scripts s ON s.id=v.script_id
    WHERE a.id=NEW.asset_id AND a.story_id=s.story_id
  ) THEN
    RAISE EXCEPTION 'asset and video belong to different stories'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$usage$;

CREATE TRIGGER validate_asset_usage_story
BEFORE INSERT OR UPDATE ON vns.asset_uses
FOR EACH ROW EXECUTE FUNCTION vns.validate_asset_usage_story();

-- P3-02 has not evaluated any actual license, trademark or model release.
-- Fail closed even for complete metadata and for legacy "cleared" rows.
CREATE VIEW vns.asset_rights_readiness AS
SELECT a.id AS asset_id,
  'BLOCKED'::text AS effective_rights_status,
  false::boolean AS render_allowed,
  CASE
    WHEN a.rights_status='blocked' THEN 'explicitly_blocked'
    WHEN a.origin_url IS NULL OR a.creator IS NULL
      OR a.license_url IS NULL OR a.license_snapshot IS NULL
      OR a.content_sha256 IS NULL OR a.license_id IS NULL
      OR a.attribution IS NULL OR btrim(a.attribution)=''
      THEN 'missing_provenance'
    ELSE 'license_policy_pending'
  END::text AS reason
FROM vns.assets a;

REVOKE ALL ON vns.asset_uses, vns.asset_rights_readiness FROM PUBLIC;
REVOKE ALL ON FUNCTION vns.protect_asset_provenance() FROM PUBLIC;
REVOKE ALL ON FUNCTION vns.validate_asset_usage_story() FROM PUBLIC;
-- No runtime, API, editor, render or upload grants are introduced.

INSERT INTO vns.schema_migrations(version)
VALUES ('0064_asset_provenance_catalog');
COMMIT;
