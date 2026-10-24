-- P1-07: offline-only editor identity schema and atomic review audit ledger.
-- Do not deploy without operator-approved backups, DB role privileges and recovery.
BEGIN;

-- Accounts are initially empty. This migration grants no login or reviewer
-- powers; opt-in individual authentication must be implemented separately.
CREATE TABLE vns.editor_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE
    CHECK (username ~ '^[a-z][a-z0-9_-]{2,31}$'),
  display_name text NOT NULL
    CHECK (char_length(btrim(display_name)) BETWEEN 3 AND 100),
  role text NOT NULL CHECK (role IN ('editor', 'reviewer', 'admin')),
  password_hash text NOT NULL
    CHECK (password_hash ~ '^scrypt[$][0-9a-f]{32}[$][0-9a-f]{128}$'),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vns.research_evidence
  ADD COLUMN review_reason text,
  ADD COLUMN reviewer_editor_id uuid REFERENCES vns.editor_accounts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT evidence_review_reason_format CHECK (
    review_reason IS NULL OR (
      char_length(review_reason) BETWEEN 20 AND 500
      AND review_reason = btrim(review_reason)
      AND review_reason !~ '[[:cntrl:]]'
    )
  );

-- No retroactive event is fabricated for previously reviewed evidence. These
-- historical rows may have NULL reason; all NEW transitions require a reason.
CREATE FUNCTION vns.require_evidence_review_reason() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.review_status = 'candidate' AND NEW.review_status <> 'candidate' THEN
    IF NEW.review_reason IS NULL OR
       char_length(NEW.review_reason) NOT BETWEEN 20 AND 500 OR
       NEW.review_reason <> btrim(NEW.review_reason) OR
       NEW.review_reason ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'editorial review reason is mandatory'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER require_evidence_review_reason
  BEFORE UPDATE ON vns.research_evidence
  FOR EACH ROW EXECUTE FUNCTION vns.require_evidence_review_reason();

CREATE TABLE vns.evidence_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL REFERENCES vns.research_evidence(id) ON DELETE RESTRICT,
  editor_id uuid REFERENCES vns.editor_accounts(id) ON DELETE RESTRICT,
  reviewer_label text NOT NULL CHECK (char_length(btrim(reviewer_label)) BETWEEN 3 AND 100),
  before_status text NOT NULL CHECK (before_status = 'candidate'),
  after_status text NOT NULL CHECK (after_status IN ('verified', 'disputed', 'rejected')),
  reason text NOT NULL CHECK (
    char_length(reason) BETWEEN 20 AND 500 AND reason = btrim(reason)
    AND reason !~ '[[:cntrl:]]'
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (evidence_id)
);
CREATE INDEX review_events_recorded_idx ON vns.evidence_review_events (recorded_at DESC);

CREATE FUNCTION vns.capture_evidence_review_event() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.review_status = 'candidate' AND NEW.review_status <> 'candidate' THEN
    INSERT INTO vns.evidence_review_events
      (evidence_id, editor_id, reviewer_label, before_status, after_status,
       reason, recorded_at)
    VALUES
      (NEW.id, NEW.reviewer_editor_id, NEW.reviewer,
       OLD.review_status, NEW.review_status, NEW.review_reason, NEW.reviewed_at);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER capture_evidence_review_event
  AFTER UPDATE ON vns.research_evidence
  FOR EACH ROW EXECUTE FUNCTION vns.capture_evidence_review_event();

CREATE FUNCTION vns.prevent_review_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'evidence review log is append-only' USING ERRCODE = '22023';
END;
$function$;

CREATE TRIGGER prevent_review_event_mutation
  BEFORE UPDATE OR DELETE ON vns.evidence_review_events
  FOR EACH ROW EXECUTE FUNCTION vns.prevent_review_event_mutation();

COMMENT ON TABLE vns.evidence_review_events IS
  'Append-only under ordinary DB permissions; privileged DB owners can still alter data or disable triggers';
COMMENT ON COLUMN vns.evidence_review_events.editor_id IS
  'NULL represents a legacy shared admin session, not a named editor';
INSERT INTO vns.schema_migrations (version) VALUES ('0005_editorial_review_audit');
COMMIT;
