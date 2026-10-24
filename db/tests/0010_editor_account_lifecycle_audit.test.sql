-- Disposable PostgreSQL / independent database owner only.
-- No real operator enrollment occurs in migrations or deployment.
DO $checks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='vns_lifecycle_audit_writer'
     AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole) THEN
    RAISE EXCEPTION 'Auditor role is not isolated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid =
     (SELECT oid FROM pg_roles WHERE rolname='vns_lifecycle_audit_writer')) THEN
    RAISE EXCEPTION 'Auditor role has members';
  END IF;
  IF has_table_privilege('vns_editor_provisioner',
      'vns.editor_operator_registry','SELECT')
     OR has_table_privilege('vns_editor_provisioner',
      'vns.editor_account_lifecycle_events','INSERT')
     OR has_table_privilege('vns_api_runtime',
      'vns.editor_account_lifecycle_events','SELECT') THEN
    RAISE EXCEPTION 'Audit registry or event permission leaked';
  END IF;
END;
$checks$;

-- Missing verified operator MUST deny create, even with provisioner grants.
SET ROLE vns_editor_provisioner;
DO $negative$
BEGIN
  BEGIN
    INSERT INTO vns.editor_accounts(username,display_name,role,password_hash)
    VALUES ('ci_not_registered','Not Registered','reviewer',
            'scrypt$'||repeat('a',32)||'$'||repeat('b',128));
    RAISE EXCEPTION 'Missing operator enrollment was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$negative$;
RESET ROLE;

-- Only disposable CI: this mapping labels its synthetic database owner,
-- NOT a real human operator. A production registry stays completely empty.
INSERT INTO vns.editor_operator_registry
  (login_role,operator_id,operator_label,active)
VALUES (session_user, 'aaaaaaaa-1234-4123-8123-aaaaaaaaaaaa'::uuid,
        'Synthetic CI Migration Owner', true);

SET ROLE vns_editor_provisioner;
INSERT INTO vns.editor_accounts(username,display_name,role,password_hash)
VALUES ('ci_account_audit','CI Audited Editor','reviewer',
        'scrypt$'||repeat('a',32)||'$'||repeat('b',128));
UPDATE vns.editor_accounts SET active=true WHERE username='ci_account_audit';
UPDATE vns.editor_accounts SET password_hash=
 'scrypt$'||repeat('c',32)||'$'||repeat('d',128)
 WHERE username='ci_account_audit';
UPDATE vns.editor_accounts SET role='editor' WHERE username='ci_account_audit';
UPDATE vns.editor_accounts SET active=false WHERE username='ci_account_audit';
UPDATE vns.editor_accounts SET display_name='CI Audited Editor Updated'
 WHERE username='ci_account_audit';
UPDATE vns.editor_accounts SET active=false WHERE username='ci_account_audit';
RESET ROLE;

DO $audit$
BEGIN
  IF (SELECT count(*) FROM vns.editor_account_lifecycle_events
     WHERE editor_username='ci_account_audit') <> 6 THEN
    RAISE EXCEPTION 'Incorrect number of audit lifecycle events';
  END IF;
  IF (SELECT count(*) FROM vns.editor_account_lifecycle_events
      WHERE editor_username='ci_account_audit' AND password_rotated) <> 1 THEN
    RAISE EXCEPTION 'Password rotation was not recorded';
  END IF;
  IF (SELECT count(*) FROM vns.editor_account_lifecycle_events
      WHERE editor_username='ci_account_audit'
        AND operator_login=session_user
        AND operator_id='aaaaaaaa-1234-4123-8123-aaaaaaaaaaaa'::uuid) <> 6 THEN
    RAISE EXCEPTION 'DB-authenticated operator identity not attributed';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='vns'
               AND table_name='editor_account_lifecycle_events'
               AND column_name ILIKE '%password%hash%') THEN
    RAISE EXCEPTION 'Audit contains credential hash column';
  END IF;
  BEGIN
    DELETE FROM vns.editor_account_lifecycle_events;
    RAISE EXCEPTION 'Audit ledger deletion allowed';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END;
$audit$;

SET ROLE vns_editor_provisioner;
DO $denials$
BEGIN
  BEGIN
    EXECUTE 'UPDATE vns.editor_account_lifecycle_events SET operation=''updated''';
    RAISE EXCEPTION 'Provisioner could alter audit';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    EXECUTE 'INSERT INTO vns.editor_operator_registry(login_role,operator_id,operator_label) VALUES (''spoofed'',gen_random_uuid(),''Spoofed Operator'')';
    RAISE EXCEPTION 'Provisioner could enroll itself';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$denials$;
RESET ROLE;
