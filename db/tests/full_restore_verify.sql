-- Assert recovery is semantically correct, not merely a successful pg_restore.
-- All data and credentials are synthetic. This file runs on both test DBs.
BEGIN;

DO $verify$
DECLARE
  total integer;
  owner_name name;
BEGIN
  SELECT count(*) INTO total FROM vns.schema_migrations
  WHERE version IN (
   '0001_editorial_core','0002_job_outbox','0003_research_requests',
   '0004_research_evidence','0005_editorial_review_audit',
   '0006_offline_role_boundaries','0007_runtime_role_boundaries',
   '0008_editor_session_revocation','0009_scoped_editor_review',
   '0010_editor_account_lifecycle_audit','0011_operator_registry_governance',
   '0012_runtime_least_privilege','0013_synthetic_token_usage',
   '0014_synthetic_ai_budget_reservations'
  );
  IF total<>14 OR (SELECT count(*) FROM vns.schema_migrations)<>14 THEN
    RAISE EXCEPTION 'Full migration ledger was not recovered';
  END IF;

  SELECT count(*) INTO total FROM pg_roles
  WHERE rolname IN (
    'vns_editor_provisioner','vns_audit_reader','vns_api_runtime',
    'vns_outbox_dispatcher','vns_review_event_writer',
    'vns_editor_review_executor','vns_lifecycle_audit_writer',
    'vns_operator_governor','vns_operator_registry_executor',
    'vns_outbox_dispatch','vns_job_status_sync','vns_research_writer'
  ) AND NOT rolcanlogin AND NOT rolsuper;
  IF total<>12 THEN RAISE EXCEPTION 'A NOLOGIN application role was not restored'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname='vns_ci_restore_operator'
      AND rolcanlogin AND NOT rolsuper
  ) OR NOT pg_has_role('vns_ci_restore_operator',
                      'vns_editor_provisioner','MEMBER') THEN
    RAISE EXCEPTION 'Global-role memberships were lost';
  END IF;
  IF pg_has_role('vns_ci_restore_operator','vns_api_runtime','MEMBER') THEN
    RAISE EXCEPTION 'Restored provisioner accidentally inherited API role';
  END IF;

  IF NOT has_function_privilege('vns_api_runtime',
      'vns.review_evidence_as_editor(uuid,text,text,uuid,integer)','EXECUTE')
    OR has_function_privilege('vns_outbox_dispatcher',
      'vns.review_evidence_as_editor(uuid,text,text,uuid,integer)','EXECUTE')
    OR has_table_privilege('vns_api_runtime','vns.editor_accounts','UPDATE')
    OR has_table_privilege('vns_outbox_dispatcher',
                          'vns.editor_accounts','SELECT')
    OR has_table_privilege('vns_editor_provisioner',
                          'vns.editor_operator_registry','INSERT')
    OR NOT has_table_privilege('vns_audit_reader',
                          'vns.editor_operator_registry_events','SELECT')
  THEN RAISE EXCEPTION 'Least-privilege grants were not recovered'; END IF;

  SELECT pg_get_userbyid(proowner) INTO owner_name FROM pg_proc
    WHERE oid='vns.review_evidence_as_editor(uuid,text,text,uuid,integer)'::regprocedure;
  IF owner_name<>'vns_editor_review_executor' OR NOT EXISTS(
    SELECT 1 FROM pg_proc
    WHERE oid='vns.review_evidence_as_editor(uuid,text,text,uuid,integer)'::regprocedure
      AND prosecdef
  ) THEN
    RAISE EXCEPTION 'Definer owner/privileged review function was lost';
  END IF;

  IF (SELECT count(*) FROM vns.editor_accounts
       WHERE username IN ('ci_restore_editor','ci_restore_reviewer'))<>2
    OR NOT EXISTS(SELECT 1 FROM vns.editor_accounts
        WHERE username='ci_restore_reviewer' AND active=true
          AND auth_version=2 AND role='reviewer')
    OR NOT EXISTS(SELECT 1 FROM vns.editor_accounts
        WHERE username='ci_restore_editor' AND active=false
          AND auth_version=3 AND role='reviewer')
  THEN RAISE EXCEPTION 'Editor state or session revocation was lost'; END IF;

  IF (SELECT count(*) FROM vns.editor_account_lifecycle_events
        WHERE editor_username IN ('ci_restore_editor','ci_restore_reviewer'))<>7
    OR NOT EXISTS(SELECT 1 FROM vns.editor_account_lifecycle_events
        WHERE editor_username='ci_restore_reviewer' AND password_rotated
          AND operator_login='postgres')
  THEN RAISE EXCEPTION 'Account lifecycle audit events were lost'; END IF;

  IF (SELECT count(*) FROM vns.editor_operator_registry_events
      WHERE login_role='vns_ci_restore_operator'
        AND event_type='registered' AND authorized_by='postgres')<>1
    OR NOT EXISTS(SELECT 1 FROM vns.editor_operator_registry
        WHERE login_role='vns_ci_restore_operator' AND active)
  THEN RAISE EXCEPTION 'Operator registration and governance audit lost'; END IF;

  IF (SELECT count(*) FROM vns.evidence_review_events)<>2
    OR NOT EXISTS(SELECT 1 FROM vns.evidence_review_events
          WHERE reviewer_label='ci_restore_reviewer'
          AND editor_id IS NOT NULL AND after_status='verified')
    OR NOT EXISTS(SELECT 1 FROM vns.evidence_review_events
          WHERE reviewer_label='admin-session'
          AND editor_id IS NULL AND after_status='disputed')
  THEN RAISE EXCEPTION 'Named or legacy source review audit lost'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='vns.editor_accounts'::regclass
      AND tgname='capture_editor_account_lifecycle' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='vns.editor_operator_registry_events'::regclass
      AND tgname='prevent_operator_registry_event_mutation'
      AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'Audit trigger protection not recovered'; END IF;

  -- Original application data must still be linked and queue recovery-ready.
  IF NOT EXISTS(SELECT 1 FROM vns.jobs j
     JOIN vns.job_outbox o ON o.job_id=j.id
     WHERE j.idempotency_key='ci-restore-job'
       AND j.status='retry' AND j.attempt_count=1
       AND o.delivery_state='enqueued' AND o.dispatch_attempts=1)
    OR (SELECT count(*) FROM vns.research_evidence)<>2
    OR (SELECT count(*) FROM vns.stories
        WHERE slug='restore-fixture-story')<>1
  THEN RAISE EXCEPTION 'Core editorial/outbox data is missing'; END IF;

  -- New token receipts must survive independent logical archive/role restore.
  IF (SELECT count(*) FROM vns.job_token_usage)<>1
     OR NOT EXISTS(
       SELECT 1 FROM vns.job_token_usage t
       JOIN vns.jobs j ON j.id=t.job_id
       WHERE j.idempotency_key='ci-restore-job'
         AND t.provider='ci_fixture'
         AND t.model='restore_model'
         AND t.request_id='ci_restore_req_001'
         AND t.input_tokens=1000
         AND t.output_tokens=500
         AND t.estimated_cost_micro_usd=6000
         AND t.source_type='synthetic'
     )
     OR has_table_privilege('vns_api_runtime','vns.job_token_usage','SELECT')
     OR has_table_privilege('vns_research_writer','vns.job_token_usage','INSERT')
  THEN RAISE EXCEPTION 'Synthetic token ledger restore/ACLs invalid'; END IF;

  -- The synthetic-only daily quota and retry ledger must survive restore.
  IF (SELECT count(*) FROM vns.synthetic_ai_budget_days)<>1
     OR NOT EXISTS(
       SELECT 1 FROM vns.synthetic_ai_budget_days
       WHERE budget_day=DATE '2026-10-25'
         AND cap_micro_usd=2000000 AND reserved_micro_usd=90000
     )
     OR (SELECT count(*) FROM vns.synthetic_ai_reservations)<>1
     OR NOT EXISTS(
       SELECT 1 FROM vns.synthetic_ai_reservations r
       JOIN vns.jobs j ON j.id=r.job_id
       WHERE j.idempotency_key='ci-restore-job'
         AND r.provider='synthetic_openai'
         AND r.request_id='ci_restore_budget_req_001'
         AND r.stage='script_draft' AND r.model='gpt-6.1-sol'
         AND r.max_input_tokens=20000 AND r.max_output_tokens=5000
         AND r.reserved_micro_usd=90000 AND r.state='reserved'
         AND r.source_type='synthetic'
     )
     OR has_table_privilege('vns_api_runtime','vns.synthetic_ai_budget_days','SELECT')
     OR has_table_privilege('vns_research_writer','vns.synthetic_ai_reservations','INSERT')
     OR has_function_privilege('vns_api_runtime',
         'vns.reserve_synthetic_ai_budget(uuid,text,text,text,integer,integer,date)',
         'EXECUTE')
  THEN RAISE EXCEPTION 'Synthetic budget restore/ACLs invalid'; END IF;

  -- Mutation and uniqueness protections must still fail closed after restore.
  BEGIN
    DELETE FROM vns.editor_operator_registry_events;
    RAISE EXCEPTION 'Operator governance ledger became deletable';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    DELETE FROM vns.editor_account_lifecycle_events;
    RAISE EXCEPTION 'Editor lifecycle ledger became deletable';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    DELETE FROM vns.evidence_review_events;
    RAISE EXCEPTION 'Source-review ledger became deletable';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    INSERT INTO vns.jobs (kind,idempotency_key)
       VALUES ('research','ci-restore-job');
    RAISE EXCEPTION 'Job uniqueness check was lost';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$verify$;

-- Recovered governance function must still reject repeated approvals.
SET ROLE vns_operator_governor;
DO $recovered_governance$
BEGIN
  BEGIN
    PERFORM vns.register_editor_operator(
      'vns_ci_restore_operator',
      'cccccccc-3333-4333-8333-cccccccccccc',
      'Illegal Reenrollment',
      'A recovered database must reject duplicate operator enrollment.');
    RAISE EXCEPTION 'Operator uniqueness not enforced after restore';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$recovered_governance$;
RESET ROLE;

ROLLBACK;
