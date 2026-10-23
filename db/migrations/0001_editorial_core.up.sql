-- P1-05 / 0001: first editorial data model for PostgreSQL 17.
-- Intentionally offline: do NOT run on the VPS without a separate data/backup approval.
-- Fail closed if applied twice or objects already exist.
BEGIN;

CREATE SCHEMA vns;

CREATE TABLE vns.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION vns.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TABLE vns.sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  canonical_url text NOT NULL UNIQUE CHECK (canonical_url ~* '^https?://[^[:space:]]+$'),
  trust_status text NOT NULL DEFAULT 'candidate'
    CHECK (trust_status IN ('candidate', 'trusted', 'blocked')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vns.licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  reference_url text,
  attribution_rule text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vns.stories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES vns.sources(id) ON DELETE RESTRICT,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text NOT NULL CHECK (btrim(title) <> ''),
  summary text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'review', 'ready', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stories_source_id_idx ON vns.stories(source_id);

CREATE TABLE vns.claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid NOT NULL REFERENCES vns.stories(id) ON DELETE RESTRICT,
  source_id uuid NOT NULL REFERENCES vns.sources(id) ON DELETE RESTRICT,
  statement text NOT NULL CHECK (btrim(statement) <> ''),
  evidence_url text NOT NULL CHECK (evidence_url ~* '^https?://[^[:space:]]+$'),
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'verified', 'disputed', 'rejected')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claims_verified_date_required
    CHECK (verification_status <> 'verified' OR verified_at IS NOT NULL)
);
CREATE INDEX claims_story_id_idx ON vns.claims(story_id);
CREATE INDEX claims_source_id_idx ON vns.claims(source_id);

CREATE TABLE vns.assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid NOT NULL REFERENCES vns.stories(id) ON DELETE RESTRICT,
  source_id uuid REFERENCES vns.sources(id) ON DELETE RESTRICT,
  license_id uuid REFERENCES vns.licenses(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'document')),
  storage_key text NOT NULL UNIQUE CHECK (btrim(storage_key) <> ''),
  rights_status text NOT NULL DEFAULT 'unreviewed'
    CHECK (rights_status IN ('unreviewed', 'cleared', 'blocked')),
  rights_verified_at timestamptz,
  attribution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_rights_clearance_required
    CHECK (rights_status <> 'cleared'
      OR (license_id IS NOT NULL AND rights_verified_at IS NOT NULL))
);
CREATE INDEX assets_story_id_idx ON vns.assets(story_id);
CREATE INDEX assets_license_id_idx ON vns.assets(license_id);

CREATE TABLE vns.scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid NOT NULL REFERENCES vns.stories(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version >= 1),
  body text NOT NULL CHECK (btrim(body) <> ''),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'review', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (story_id, version)
);
CREATE INDEX scripts_story_id_idx ON vns.scripts(story_id);

CREATE TABLE vns.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid REFERENCES vns.stories(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('research', 'script', 'render', 'upload')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'retry', 'done', 'failed', 'cancelled')),
  idempotency_key text UNIQUE CHECK (idempotency_key IS NULL OR btrim(idempotency_key) <> ''),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (attempt_count <= max_attempts)
);
CREATE INDEX jobs_story_status_idx ON vns.jobs(story_id, status);

CREATE TABLE vns.videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id uuid NOT NULL REFERENCES vns.scripts(id) ON DELETE RESTRICT,
  render_job_id uuid REFERENCES vns.jobs(id) ON DELETE RESTRICT,
  storage_key text UNIQUE CHECK (storage_key IS NULL OR btrim(storage_key) <> ''),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms > 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'rendered', 'approved', 'published')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX videos_script_id_idx ON vns.videos(script_id);

CREATE TABLE vns.costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES vns.jobs(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (btrim(provider) <> ''),
  metric text NOT NULL CHECK (btrim(metric) <> ''),
  quantity numeric(18, 6) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  amount numeric(18, 6) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX costs_job_id_idx ON vns.costs(job_id);

CREATE TABLE vns.approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES vns.videos(id) ON DELETE RESTRICT,
  reviewer text NOT NULL CHECK (btrim(reviewer) <> ''),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_video_created_idx ON vns.approvals(video_id, created_at);

CREATE TABLE vns.uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES vns.videos(id) ON DELETE RESTRICT,
  platform text NOT NULL CHECK (btrim(platform) <> ''),
  external_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'uploading', 'published', 'failed', 'cancelled')),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uploads_publication_metadata_required
    CHECK (status <> 'published'
      OR (external_id IS NOT NULL AND btrim(external_id) <> '' AND completed_at IS NOT NULL))
);
CREATE INDEX uploads_video_id_idx ON vns.uploads(video_id);
CREATE UNIQUE INDEX uploads_platform_external_id_unique
  ON vns.uploads(platform, external_id) WHERE external_id IS NOT NULL;

DO $triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sources', 'licenses', 'stories', 'claims', 'assets',
    'scripts', 'jobs', 'videos', 'costs', 'approvals', 'uploads'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER touch_updated_at BEFORE UPDATE ON vns.%I
       FOR EACH ROW EXECUTE FUNCTION vns.touch_updated_at()',
      table_name
    );
  END LOOP;
END;
$triggers$;

INSERT INTO vns.schema_migrations (version) VALUES ('0001_editorial_core');

COMMIT;
