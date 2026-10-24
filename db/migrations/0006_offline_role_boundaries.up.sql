-- P1-07: Git-only role boundaries, NOT production role provisioning.
-- Requires a separately approved privileged migration and real backup plan.
-- These NOLOGIN roles receive no members or passwords.
BEGIN;

CREATE ROLE vns_editor_provisioner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE vns_audit_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

GRANT USAGE ON SCHEMA vns TO vns_editor_provisioner, vns_audit_reader;

-- Provisioning is deliberately separate from API authentication. New accounts
-- cannot be inserted active: activation requires a distinct UPDATE action.
-- The provisioner may rotate stored password hashes but cannot SELECT them,
-- delete identities, change usernames, or edit evidence/audit records.
GRANT SELECT (id, username, display_name, role, active, created_at)
  ON vns.editor_accounts TO vns_editor_provisioner;
GRANT INSERT (username, display_name, role, password_hash)
  ON vns.editor_accounts TO vns_editor_provisioner;
GRANT UPDATE (display_name, role, password_hash, active)
  ON vns.editor_accounts TO vns_editor_provisioner;

-- Audit exports may read append-only events but not account password hashes,
-- jobs, or editorial decisions through any write privilege.
GRANT SELECT ON vns.evidence_review_events TO vns_audit_reader;

COMMENT ON ROLE vns_editor_provisioner IS
  'Offline only, NOLOGIN. A separately authorized operator may provision/rotate editor accounts.';
COMMENT ON ROLE vns_audit_reader IS
  'Offline only, NOLOGIN. Read-only audited source-verdict events; no grants to login users.';

INSERT INTO vns.schema_migrations (version) VALUES ('0006_offline_role_boundaries');
COMMIT;
