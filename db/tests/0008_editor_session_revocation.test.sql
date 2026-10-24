-- Real disposable PostgreSQL assertions on versioned personal sessions.
-- Provisioner must be unable to write auth_version directly.
SET ROLE vns_editor_provisioner;
INSERT INTO vns.editor_accounts
  (username, display_name, role, password_hash)
  VALUES ('ci_rotation', 'CI Rotation Account', 'reviewer',
          'scrypt$' || repeat('a', 32) || '$' || repeat('b', 128));
DO $test$
BEGIN
  BEGIN
    EXECUTE 'UPDATE vns.editor_accounts SET auth_version = 900 WHERE username = ''ci_rotation''';
    RAISE EXCEPTION 'Provisioner forged auth version';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;
UPDATE vns.editor_accounts SET active=true WHERE username='ci_rotation';
UPDATE vns.editor_accounts SET password_hash =
  'scrypt$' || repeat('c', 32) || '$' || repeat('d', 128)
  WHERE username='ci_rotation';
UPDATE vns.editor_accounts SET role='editor' WHERE username='ci_rotation';
UPDATE vns.editor_accounts SET active=false WHERE username='ci_rotation';
UPDATE vns.editor_accounts SET active=true WHERE username='ci_rotation';
-- Same-value changes must not accidentally revoke an unrelated session.
UPDATE vns.editor_accounts SET active=true WHERE username='ci_rotation';
RESET ROLE;

DO $test$
BEGIN
  IF (SELECT auth_version FROM vns.editor_accounts
      WHERE username='ci_rotation') <> 5 THEN
    RAISE EXCEPTION 'Account lifecycle version must increment exactly five times';
  END IF;
  IF EXISTS (SELECT 1 FROM vns.editor_accounts
             WHERE username='ci_rotation' AND
               (active=false OR role <> 'editor')) THEN
    RAISE EXCEPTION 'Account lifecycle state mismatch';
  END IF;
  BEGIN
    UPDATE vns.editor_accounts SET auth_version = 1
    WHERE username = 'ci_rotation';
    RAISE EXCEPTION 'Direct version regression accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END;
$test$;
