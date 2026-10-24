-- Destructive offline rollback. Must never run on live editor data.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version = '0005_editorial_review_audit';
DROP TABLE vns.evidence_review_events;
DROP FUNCTION vns.prevent_review_event_mutation();
DROP TRIGGER capture_evidence_review_event ON vns.research_evidence;
DROP FUNCTION vns.capture_evidence_review_event();
DROP TRIGGER require_evidence_review_reason ON vns.research_evidence;
DROP FUNCTION vns.require_evidence_review_reason();
ALTER TABLE vns.research_evidence DROP CONSTRAINT evidence_review_reason_format,
  DROP COLUMN review_reason, DROP COLUMN reviewer_editor_id;
DROP TABLE vns.editor_accounts;
COMMIT;
