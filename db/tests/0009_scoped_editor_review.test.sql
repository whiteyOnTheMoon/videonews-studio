-- Disposable PostgreSQL test for actual least-privilege named review execution.
DO $role_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles
                 WHERE rolname='vns_editor_review_executor' AND NOT rolcanlogin
                   AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole) THEN
    RAISE EXCEPTION 'Restricted review executor role missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members
             WHERE roleid=(SELECT oid FROM pg_roles
                           WHERE rolname='vns_editor_review_executor')) THEN
    RAISE EXCEPTION 'Review executor must have no members';
  END IF;
  IF has_table_privilege('vns_api_runtime','vns.editor_accounts','UPDATE')
     OR has_column_privilege('vns_api_runtime','vns.editor_accounts','id','UPDATE')
     OR has_column_privilege('vns_api_runtime','vns.research_evidence',
                             'review_status','UPDATE')
     OR has_table_privilege('vns_api_runtime','vns.evidence_review_events','INSERT')
     OR has_function_privilege('vns_outbox_dispatcher',
       'vns.review_evidence_as_editor(uuid,text,text,uuid,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Runtime API/public acquired unsafe privileges';
  END IF;
  IF NOT has_function_privilege('vns_api_runtime',
      'vns.review_evidence_as_editor(uuid,text,text,uuid,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'API cannot execute the scoped review function';
  END IF;
END;
$role_check$;

INSERT INTO vns.editor_accounts(username,display_name,role,password_hash,active)
VALUES
 ('ci_scoped_reviewer','CI Scoped Reviewer','reviewer',
  'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
 ('ci_scoped_editor','CI Scoped Editor','editor',
  'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
 ('ci_scoped_inactive','CI Inactive Reviewer','reviewer',
  'scrypt$'||repeat('a',32)||'$'||repeat('b',128),false);

SELECT vns.create_research_request(
 'ci-scoped-review-job-key-00001','An isolated security boundary review demonstration'
);
INSERT INTO vns.research_evidence(job_id,source_url,publisher,headline,claim_text)
SELECT id,'https://example.org/scoped-review','CI Publisher',
       'Scoped permission review test', 'This synthetic claim is only for isolated CI.'
FROM vns.jobs WHERE idempotency_key='ci-scoped-review-job-key-00001';

SET ROLE vns_api_runtime;
DO $assert$
DECLARE
  proof_id uuid;
  reviewer_id uuid;
  editor_id uuid;
  inactive_id uuid;
  value text;
BEGIN
  SELECT id INTO proof_id FROM vns.research_evidence
    WHERE headline='Scoped permission review test';
  SELECT id INTO reviewer_id FROM vns.editor_accounts
    WHERE username='ci_scoped_reviewer';
  SELECT id INTO editor_id FROM vns.editor_accounts
    WHERE username='ci_scoped_editor';
  SELECT id INTO inactive_id FROM vns.editor_accounts
    WHERE username='ci_scoped_inactive';

  SELECT vns.review_evidence_as_editor(proof_id,'verified',
    'A sufficient synthetic explanation is supplied for this claim.',
    editor_id,0) INTO value;
  IF value<>'forbidden' THEN RAISE EXCEPTION 'Editor role permitted review'; END IF;
  SELECT vns.review_evidence_as_editor(proof_id,'verified',
    'A sufficient synthetic explanation is supplied for this claim.',
    inactive_id,0) INTO value;
  IF value<>'forbidden' THEN RAISE EXCEPTION 'Inactive editor permitted review'; END IF;
  SELECT vns.review_evidence_as_editor(proof_id,'verified',
    'A sufficient synthetic explanation is supplied for this claim.',
    reviewer_id,1) INTO value;
  IF value<>'forbidden' THEN RAISE EXCEPTION 'Stale session permitted review'; END IF;
  SELECT vns.review_evidence_as_editor(proof_id,'disputed',
    'The source supports only a narrower claim than stated.',
    reviewer_id,0) INTO value;
  IF value<>'updated' THEN RAISE EXCEPTION 'Review did not update'; END IF;
  SELECT vns.review_evidence_as_editor(proof_id,'rejected',
    'This is a second synthetic reason for the same source.',
    reviewer_id,0) INTO value;
  IF value<>'already_reviewed' THEN RAISE EXCEPTION 'Duplicate review was allowed'; END IF;
  SELECT vns.review_evidence_as_editor(
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'::uuid,'verified',
    'A missing item review should return the missing result.',
    reviewer_id,0) INTO value;
  IF value<>'missing' THEN RAISE EXCEPTION 'Missing evidence result wrong'; END IF;
  BEGIN
    EXECUTE 'UPDATE vns.research_evidence SET review_status=''verified''';
    RAISE EXCEPTION 'API wrote evidence directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    EXECUTE 'SELECT username FROM vns.editor_accounts FOR SHARE';
    RAISE EXCEPTION 'API acquired locked account read';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    EXECUTE 'SELECT vns.review_evidence_as_editor(NULL,NULL,NULL,NULL,NULL)';
    RAISE EXCEPTION 'Invalid review accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$assert$;
RESET ROLE;

DO $audit$
BEGIN
  IF (SELECT count(*) FROM vns.evidence_review_events
      WHERE reviewer_label='ci_scoped_reviewer'
        AND after_status='disputed'
        AND reason='The source supports only a narrower claim than stated.') <> 1 THEN
    RAISE EXCEPTION 'Missing single attributed immutable audit event';
  END IF;
END;
$audit$;
