-- Offline editorial provenance metadata. No website fetching or auto verification.
-- Do not migrate a VPS until persistent-data deployment is explicitly approved.
BEGIN;

CREATE TABLE vns.research_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES vns.research_requests(job_id) ON DELETE RESTRICT,
  source_url text NOT NULL CHECK (char_length(source_url) BETWEEN 16 AND 512)
    CHECK (source_url ~ '^https://[A-Za-z0-9-]+([.][A-Za-z0-9-]+)+([/?][^[:space:]#]*)?$'),
  publisher text NOT NULL CHECK (char_length(btrim(publisher)) BETWEEN 2 AND 120),
  headline text NOT NULL CHECK (char_length(btrim(headline)) BETWEEN 8 AND 200),
  claim_text text NOT NULL CHECK (char_length(btrim(claim_text)) BETWEEN 12 AND 280),
  observed_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  review_status text NOT NULL DEFAULT 'candidate'
    CHECK (review_status IN ('candidate', 'verified', 'disputed', 'rejected')),
  reviewer text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_review_metadata_required CHECK (
    (review_status = 'candidate' AND reviewer IS NULL AND reviewed_at IS NULL)
    OR
    (review_status <> 'candidate'
      AND reviewer IS NOT NULL AND char_length(btrim(reviewer)) BETWEEN 3 AND 100
      AND reviewed_at IS NOT NULL)
  ),
  UNIQUE (job_id, source_url, claim_text)
);
CREATE INDEX research_evidence_job_idx
  ON vns.research_evidence (job_id, created_at);

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON vns.research_evidence
  FOR EACH ROW EXECUTE FUNCTION vns.touch_updated_at();

-- Prevent silent changes to a claim's source or review history.
-- A reviewed record is immutable; correction needs a new evidence record.
CREATE FUNCTION vns.protect_research_evidence() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.review_status <> 'candidate'
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.source_url IS DISTINCT FROM OLD.source_url
     OR NEW.publisher IS DISTINCT FROM OLD.publisher
     OR NEW.headline IS DISTINCT FROM OLD.headline
     OR NEW.claim_text IS DISTINCT FROM OLD.claim_text
     OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
     OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'research evidence provenance is immutable'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER protect_research_evidence BEFORE UPDATE ON vns.research_evidence
  FOR EACH ROW EXECUTE FUNCTION vns.protect_research_evidence();

COMMENT ON TABLE vns.research_evidence IS
  'Candidate citations and human review metadata; never infer verified from URL alone';
INSERT INTO vns.schema_migrations (version) VALUES ('0004_research_evidence');
COMMIT;
