-- Destructive CI-only rollback. Run before migration 0008 down.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version='0009_scoped_editor_review';

REVOKE EXECUTE ON FUNCTION vns.review_evidence_as_editor(uuid,text,text,uuid,integer)
  FROM vns_api_runtime;
DROP FUNCTION vns.review_evidence_as_editor(uuid,text,text,uuid,integer);

GRANT UPDATE (review_status, reviewer, review_reason, reviewer_editor_id, reviewed_at)
  ON vns.research_evidence TO vns_api_runtime;
REVOKE UPDATE (review_status, review_reason, reviewer_editor_id, reviewer, reviewed_at)
  ON vns.research_evidence FROM vns_editor_review_executor;
REVOKE SELECT ON vns.research_evidence FROM vns_editor_review_executor;
REVOKE UPDATE (id) ON vns.editor_accounts FROM vns_editor_review_executor;
REVOKE SELECT (id, username, role, active, auth_version)
  ON vns.editor_accounts FROM vns_editor_review_executor;
REVOKE USAGE ON SCHEMA vns FROM vns_editor_review_executor;
DROP ROLE vns_editor_review_executor;
COMMIT;
