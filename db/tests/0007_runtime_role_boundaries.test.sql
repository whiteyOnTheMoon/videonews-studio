-- Offline, disposable PostgreSQL: positive paths and fail-closed permissions.
-- CI must test all three NOLOGIN roles with SET ROLE.
DO $role_check$
BEGIN
  IF (SELECT count(*) FROM pg_roles
      WHERE rolname IN ('vns_api_runtime', 'vns_outbox_dispatcher',
                        'vns_review_event_writer')) <> 3 THEN
    RAISE EXCEPTION 'Runtime roles missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('vns_api_runtime', 'vns_outbox_dispatcher',
                      'vns_review_event_writer')
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole)
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname IN
                     ('vns_api_runtime', 'vns_outbox_dispatcher',
                      'vns_review_event_writer'))
  ) THEN
    RAISE EXCEPTION 'Runtime roles must be inert/no memberships';
  END IF;
END;
$role_check$;

-- Test data are synthetic and exist only in the disposable test database.
INSERT INTO vns.editor_accounts
  (username, display_name, role, password_hash, active)
VALUES ('ci_runtime_reviewer', 'CI Runtime Reviewer', 'reviewer',
        'scrypt$' || repeat('a', 32) || '$' || repeat('b', 128), true);

SET ROLE vns_api_runtime;
DO $api_check$
BEGIN
  IF has_table_privilege(current_user, 'vns.editor_accounts', 'INSERT')
     OR has_table_privilege(current_user, 'vns.editor_accounts', 'UPDATE')
     OR has_table_privilege(current_user, 'vns.editor_accounts', 'DELETE')
     OR has_table_privilege(current_user, 'vns.evidence_review_events', 'INSERT')
     OR has_column_privilege(current_user, 'vns.research_evidence',
                             'source_url', 'UPDATE')
     OR has_table_privilege(current_user, 'vns.job_outbox', 'UPDATE')
     OR has_table_privilege(current_user, 'vns.jobs', 'UPDATE') THEN
    RAISE EXCEPTION 'API acquired forbidden write privileges';
  END IF;
END;
$api_check$;

-- SECURITY INVOKER job creation needs real write privileges at call time.
SELECT vns.create_research_request('ci-runtime-role-idempotent-key-00001',
                                   'Isolated runtime SQL privilege testing');
SELECT vns.create_research_request('ci-runtime-role-idempotent-key-00001',
                                   'Isolated runtime SQL privilege testing');

DO $api_denials$
BEGIN
  BEGIN
    EXECUTE 'SELECT 1 FROM vns.evidence_review_events LIMIT 1';
    RAISE EXCEPTION 'API read the audit ledger';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    EXECUTE 'INSERT INTO vns.editor_accounts (username,display_name,role,password_hash) VALUES (''ci_forged'', ''Forged Account'', ''admin'', ''scrypt$'' || repeat(''a'',32) || ''$'' || repeat(''b'',128))';
    RAISE EXCEPTION 'API created an editor account';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$api_denials$;
RESET ROLE;

INSERT INTO vns.research_evidence
  (job_id, source_url, publisher, headline, claim_text)
SELECT id, 'https://example.org/ci-runtime-evidence', 'CI Publisher',
       'Runtime review audit isolation evidence',
       'This claim is a disposable runtime role test.'
FROM vns.jobs WHERE idempotency_key = 'ci-runtime-role-idempotent-key-00001';

SET ROLE vns_api_runtime;
-- The audit INSERT must happen via a security-definer trigger, *not*
-- an API-level INSERT grant. The trigger owner is not a superuser.
UPDATE vns.research_evidence
SET review_status = 'disputed',
    review_reason = 'The source does not support this claim in the stated context.',
    reviewer_editor_id = (SELECT id FROM vns.editor_accounts
                          WHERE username = 'ci_runtime_reviewer'),
    reviewer = 'ci_runtime_reviewer',
    reviewed_at = clock_timestamp()
WHERE headline = 'Runtime review audit isolation evidence'
  AND review_status = 'candidate';
RESET ROLE;

DO $audit_check$
BEGIN
  IF (SELECT count(*) FROM vns.evidence_review_events
      WHERE reviewer_label = 'ci_runtime_reviewer'
        AND after_status = 'disputed') <> 1 THEN
    RAISE EXCEPTION 'SECURITY DEFINER trigger failed to create one audit event';
  END IF;
  IF (SELECT rolsuper FROM pg_roles
      WHERE rolname = 'vns_review_event_writer') THEN
    RAISE EXCEPTION 'Audit trigger owner must never be superuser';
  END IF;
END;
$audit_check$;

SET ROLE vns_outbox_dispatcher;
DO $dispatcher_check$
BEGIN
  IF has_table_privilege(current_user, 'vns.jobs', 'INSERT')
     OR has_table_privilege(current_user, 'vns.jobs', 'UPDATE')
     OR has_table_privilege(current_user, 'vns.editor_accounts', 'SELECT')
     OR has_table_privilege(current_user, 'vns.research_evidence', 'SELECT')
     OR has_table_privilege(current_user, 'vns.job_outbox', 'INSERT')
     OR has_table_privilege(current_user, 'vns.job_outbox', 'DELETE')
     OR has_column_privilege(current_user, 'vns.job_outbox',
                             'queue_job_id', 'UPDATE') THEN
    RAISE EXCEPTION 'Dispatcher acquired forbidden privileges';
  END IF;
END;
$dispatcher_check$;

UPDATE vns.job_outbox
SET delivery_state = 'enqueued', enqueued_at = clock_timestamp(),
    dispatch_attempts = dispatch_attempts + 1,
    last_attempt_at = clock_timestamp()
WHERE job_id IN (SELECT id FROM vns.jobs
                 WHERE idempotency_key = 'ci-runtime-role-idempotent-key-00001');
RESET ROLE;

DO $delivery_check$
BEGIN
  IF (SELECT count(*) FROM vns.job_outbox ob
      JOIN vns.jobs j ON j.id = ob.job_id
      WHERE j.idempotency_key = 'ci-runtime-role-idempotent-key-00001'
        AND ob.delivery_state = 'enqueued' AND ob.dispatch_attempts = 1) <> 1
  THEN
    RAISE EXCEPTION 'Dispatcher could not acknowledge delivery';
  END IF;
END;
$delivery_check$;

SET ROLE vns_review_event_writer;
DO $writer_check$
BEGIN
  IF NOT has_table_privilege(current_user, 'vns.evidence_review_events', 'INSERT')
     OR has_table_privilege(current_user, 'vns.evidence_review_events', 'SELECT')
     OR has_table_privilege(current_user, 'vns.editor_accounts', 'SELECT')
     OR has_table_privilege(current_user, 'vns.research_evidence', 'UPDATE')
  THEN
    RAISE EXCEPTION 'Audit writer privileges exceed narrow insert boundary';
  END IF;
END;
$writer_check$;
RESET ROLE;
