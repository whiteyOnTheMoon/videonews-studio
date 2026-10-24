-- CI-only rollback. Fail if role grants or ownership have expanded since up.
-- Never drop operator-managed roles or access in a live installation.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version = '0006_offline_role_boundaries';

REVOKE SELECT ON vns.evidence_review_events FROM vns_audit_reader;
REVOKE UPDATE (display_name, role, password_hash, active)
  ON vns.editor_accounts FROM vns_editor_provisioner;
REVOKE INSERT (username, display_name, role, password_hash)
  ON vns.editor_accounts FROM vns_editor_provisioner;
REVOKE SELECT (id, username, display_name, role, active, created_at)
  ON vns.editor_accounts FROM vns_editor_provisioner;
REVOKE USAGE ON SCHEMA vns FROM vns_audit_reader, vns_editor_provisioner;

DROP ROLE vns_audit_reader;
DROP ROLE vns_editor_provisioner;
COMMIT;
