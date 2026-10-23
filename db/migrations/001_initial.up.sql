-- P1-05 initial PostgreSQL schema. Apply inside a transaction with psql -v ON_ERROR_STOP=1.
BEGIN;
CREATE TABLE sources (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL UNIQUE,
 homepage_url text NOT NULL UNIQUE,
 feed_url text UNIQUE,
 approval_status text NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','blocked')),
 terms_url text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stories (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source_id bigint NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
 external_id text NOT NULL,
 title text NOT NULL,
 original_url text NOT NULL,
 published_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_id, external_id),
 UNIQUE(source_id, original_url)
);
CREATE TABLE claims (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 story_id bigint NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
 claim_text text NOT NULL,
 verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','verified','disputed','rejected')),
 evidence_url text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE licenses (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL,
 license_url text NOT NULL UNIQUE,
 commercial_use_allowed boolean NOT NULL DEFAULT false,
 attribution_required boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE assets (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source_story_id bigint REFERENCES stories(id) ON DELETE SET NULL,
 license_id bigint REFERENCES licenses(id) ON DELETE RESTRICT,
 origin_url text NOT NULL,
 sha256 text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 creator text,
 attribution text,
 rights_status text NOT NULL DEFAULT 'blocked' CHECK (rights_status IN ('blocked','pending','approved')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE scripts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 story_id bigint NOT NULL REFERENCES stories(id) ON DELETE RESTRICT,
 version integer NOT NULL CHECK (version > 0),
 language_code text NOT NULL,
 body text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(story_id, language_code, version)
);
CREATE TABLE jobs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 job_key text NOT NULL UNIQUE,
 kind text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 error_message text,
 started_at timestamptz,
 finished_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE videos (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 script_id bigint NOT NULL REFERENCES scripts(id) ON DELETE RESTRICT,
 job_id bigint REFERENCES jobs(id) ON DELETE SET NULL,
 file_path text NOT NULL UNIQUE,
 sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
 render_status text NOT NULL DEFAULT 'pending' CHECK (render_status IN ('pending','rendering','ready','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE costs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 job_id bigint NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
 category text NOT NULL,
 currency_code char(3) NOT NULL DEFAULT 'USD',
 amount numeric(14,6) NOT NULL CHECK (amount >= 0),
 tokens_used bigint CHECK (tokens_used IS NULL OR tokens_used >= 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE approvals (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 video_id bigint NOT NULL REFERENCES videos(id) ON DELETE RESTRICT,
 reviewer_id text NOT NULL,
 decision text NOT NULL CHECK (decision IN ('approved','rejected')),
 note text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE uploads (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 video_id bigint NOT NULL REFERENCES videos(id) ON DELETE RESTRICT,
 approval_id bigint NOT NULL REFERENCES approvals(id) ON DELETE RESTRICT,
 platform text NOT NULL,
 platform_upload_id text,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploading','published','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(platform, platform_upload_id)
);
CREATE INDEX stories_published_at_idx ON stories(published_at DESC);
CREATE INDEX claims_story_id_idx ON claims(story_id);
CREATE INDEX jobs_status_created_at_idx ON jobs(status,created_at);
CREATE INDEX costs_job_id_idx ON costs(job_id);
CREATE INDEX approvals_video_id_idx ON approvals(video_id);
CREATE INDEX uploads_video_id_idx ON uploads(video_id);
-- Database-enforced guard: approval must belong to the uploaded video.
ALTER TABLE approvals ADD CONSTRAINT approvals_id_video_unique UNIQUE(id,video_id);
ALTER TABLE uploads ADD CONSTRAINT uploads_approval_video_fk FOREIGN KEY(approval_id,video_id) REFERENCES approvals(id,video_id) ON DELETE RESTRICT;
-- Use one consistent timestamp policy across all mutable records.
CREATE FUNCTION vns_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sources','stories','claims','licenses','assets','scripts','jobs','videos','costs','approvals','uploads']
 LOOP EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION vns_set_updated_at()', t||'_updated_at',t); END LOOP;
END $$;
COMMIT;
