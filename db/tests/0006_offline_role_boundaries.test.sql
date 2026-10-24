-- Real PostgreSQL role isolation tests against disposable GitHub Actions DB.
DO $test$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('vns_editor_provisioner', 'vns_audit_reader') AND rolcanlogin
  ) THEN
    RAISE EXCEPTION 'Offline roles must never permit LOGIN';
  END IF;
  IF (SELECT count(*) FROM pg_roles
      WHERE rolname IN ('vns_editor_provisioner', 'vns_audit_reader')) <> 2 THEN
    RAISE EXCEPTION 'Missing offline boundary roles';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE roleid IN (
      SELECT oid FROM pg_roles
      WHERE rolname IN ('vns_editor_provisioner', 'vns_audit_reader')
    )
  ) THEN
    RAISE EXCEPTION 'Offline roles must have no assigned members';
  END IF;
END;
$test$;

SET ROLE vns_editor_provisioner;
DO $test$
BEGIN
  IF has_column_privilege(current_user, 'vns.editor_accounts', 'active', 'INSERT')
     OR has_column_privilege(current_user, 'vns.editor_accounts', 'password_hash', 'SELECT')
     OR has_column_privilege(current_user, 'vns.editor_accounts', 'username', 'UPDATE')
     OR has_table_privilege(current_user, 'vns.editor_accounts', 'DELETE')
     OR has_table_privilege(current_user, 'vns.research_evidence', 'UPDATE')
     OR has_table_privilege(current_user, 'vns.evidence_review_events', 'INSERT') THEN
    RAISE EXCEPTION 'Editor provisioner obtained forbidden permissions';
  END IF;
END;
$test$;

INSERT INTO vns.editor_accounts (username, display_name, role, password_hash)
VALUES ('ci_role_check', 'Disposable CI Reviewer', 'reviewer',
        'scrypt$' || repeat('a', 32) || '$' || repeat('b', 128));

DO $test$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vns.editor_accounts
                 WHERE username = 'ci_role_check' AND active = false) THEN
    RAISE EXCEPTION 'New accounts must default to inactive';
  END IF;
  BEGIN
    EXECUTE 'SELECT password_hash FROM vns.editor_accounts LIMIT 1';
    RAISE EXCEPTION 'Provisioner read credential hashes';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    EXECUTE 'INSERT INTO vns.editor_accounts (username, display_name, role, password_hash, active) VALUES (''ci_active'', ''Forbidden Active'', ''admin'', ''scrypt$'' || repeat(''a'',32) || ''$'' || repeat(''b'',128), true)';
    RAISE EXCEPTION 'Provisioner inserted active account';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;

UPDATE vns.editor_accounts SET active = true WHERE username = 'ci_role_check';
UPDATE vns.editor_accounts SET active = false WHERE username = 'ci_role_check';
RESET ROLE;

SET ROLE vns_audit_reader;
DO $test$
BEGIN
  IF NOT has_table_privilege(current_user, 'vns.evidence_review_events', 'SELECT')
     OR has_table_privilege(current_user, 'vns.evidence_review_events', 'INSERT')
     OR has_table_privilege(current_user, 'vns.evidence_review_events', 'UPDATE')
     OR has_table_privilege(current_user, 'vns.evidence_review_events', 'DELETE')
     OR has_table_privilege(current_user, 'vns.editor_accounts', 'SELECT')
     OR has_table_privilege(current_user, 'vns.jobs', 'SELECT') THEN
    RAISE EXCEPTION 'Audit reader privileges exceed readonly audit scope';
  END IF;
END;
$test$;
SELECT count(*) FROM vns.evidence_review_events;
DO $test$
BEGIN
  BEGIN
    EXECUTE 'SELECT username FROM vns.editor_accounts LIMIT 1';
    RAISE EXCEPTION 'Audit reader viewed editor account details';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    EXECUTE 'DELETE FROM vns.evidence_review_events';
    RAISE EXCEPTION 'Audit reader deleted audit records';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;
RESET ROLE;
