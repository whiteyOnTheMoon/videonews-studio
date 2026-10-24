-- Synthetic CI-only fixture spanning all 0011 migrations.
-- Never run against real users, secrets, or operational PostgreSQL.
BEGIN;

-- Account lifecycle trigger fail-closes unless the PostgreSQL session login
-- has a verified mapping; here the mapping labels a synthetic CI fixture.
INSERT INTO vns.editor_operator_registry
 (login_role,operator_id,operator_label,active)
VALUES (session_user,'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        'Synthetic Restore Fixture Owner',true);

CREATE ROLE vns_ci_restore_operator LOGIN NOINHERIT NOSUPERUSER
 NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT vns_editor_provisioner TO vns_ci_restore_operator;

-- Governed operator enrollment creates a second immutable audit family.
SET ROLE vns_operator_governor;
SELECT vns.register_editor_operator(
  'vns_ci_restore_operator',
  'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  'CI Restored Provisioner',
  'Synthetic registry enrollment for the isolated full restore verification.');
RESET ROLE;

INSERT INTO vns.editor_accounts
 (username,display_name,role,password_hash)
VALUES
 ('ci_restore_editor','CI Restore Editor','editor',
  'scrypt$'||repeat('a',32)||'$'||repeat('b',128)),
 ('ci_restore_reviewer','CI Restore Reviewer','reviewer',
  'scrypt$'||repeat('a',32)||'$'||repeat('b',128));

UPDATE vns.editor_accounts SET active=true
 WHERE username IN ('ci_restore_editor','ci_restore_reviewer');
UPDATE vns.editor_accounts SET password_hash=
 'scrypt$'||repeat('c',32)||'$'||repeat('d',128)
 WHERE username='ci_restore_reviewer';
UPDATE vns.editor_accounts SET role='reviewer'
 WHERE username='ci_restore_editor';
UPDATE vns.editor_accounts SET active=false
 WHERE username='ci_restore_editor';

-- The earlier restore seed has already created a legacy shared-admin review
-- event. Create a named, scoped source-review event as a separate identity.
DO $review$
DECLARE
  evidence_id uuid;
  editor_id uuid;
  session_version integer;
  result text;
BEGIN
  SELECT id INTO evidence_id FROM vns.research_evidence
  WHERE source_url='https://www.example.org/public-transit-report';
  SELECT id,auth_version INTO editor_id,session_version
    FROM vns.editor_accounts WHERE username='ci_restore_reviewer';
  SELECT vns.review_evidence_as_editor(
    evidence_id, 'verified',
    'The synthetic CI research source supports this specific test claim.',
    editor_id, session_version
  ) INTO result;
  IF result<>'updated' THEN
    RAISE EXCEPTION 'Named review seed was not created';
  END IF;
END;
$review$;

COMMIT;
