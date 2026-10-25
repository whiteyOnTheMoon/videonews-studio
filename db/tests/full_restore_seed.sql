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

-- Two token usage entries are synthetic; no provider billed any account.
DO $token_seed$
DECLARE
  created_id uuid;
  receipt_id uuid;
BEGIN
  SELECT id INTO created_id FROM vns.jobs WHERE idempotency_key='ci-restore-job';
  receipt_id := vns.record_synthetic_token_usage(
    created_id, 'ci_fixture', 'restore_model', 'ci_restore_req_001',
    1000, 500, 2000000, 8000000);
  IF receipt_id IS NULL
     OR vns.record_synthetic_token_usage(
       created_id, 'ci_fixture', 'restore_model', 'ci_restore_req_001',
       1000, 500, 2000000, 8000000)<>receipt_id THEN
    RAISE EXCEPTION 'Synthetic token receipt seed not idempotent';
  END IF;
END;
$token_seed$;

-- The synthetic budget reservation must also be restored with its day counter.
DO $budget_seed$
DECLARE
  j uuid;
  first_id uuid;
BEGIN
  SELECT id INTO j FROM vns.jobs WHERE idempotency_key='ci-restore-job';
  first_id := vns.reserve_synthetic_ai_budget(
    j,'ci_restore_budget_req_001','script_draft','gpt-6.1-sol',
    20000,5000,DATE '2026-10-25');
  IF first_id IS NULL OR first_id IS DISTINCT FROM
      vns.reserve_synthetic_ai_budget(
        j,'ci_restore_budget_req_001','script_draft','gpt-6.1-sol',
        20000,5000,DATE '2026-10-25') THEN
    RAISE EXCEPTION 'Synthetic budget fixture was not idempotent';
  END IF;
END;
$budget_seed$;

-- The audit fixture is model-only, with no real or encrypted API key material.
-- Using the dormant NOLOGIN role proves function grants, not a VPS login.
SET ROLE vns_provider_config_writer;
SELECT vns.admin_mutate_ai_provider(
  'openai','set_model','gpt-6-luna',NULL,NULL,NULL
);
RESET ROLE;

COMMIT;
