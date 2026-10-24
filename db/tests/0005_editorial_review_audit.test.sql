-- Disposable CI-only schema test, with explicit transaction rollback.
BEGIN;
DO $audit_test$
DECLARE
  job_id uuid;
  v_evidence_id uuid;
  account_id uuid;
  rows_seen integer;
  v_reason text := 'The original report directly supports the selected claim.';
BEGIN
  job_id := vns.create_research_request(
    'ci-review-audit-ledger-0005', 'Public transport spending scrutiny and methodology'
  );
  INSERT INTO vns.research_evidence
    (job_id, source_url, publisher, headline, claim_text)
  VALUES
    (job_id, 'https://www.example.org/sources/review-report',
     'Example Source', 'Public transport funding review',
     'The cited report describes public funding allocations.')
  RETURNING id INTO v_evidence_id;

  BEGIN
    UPDATE vns.research_evidence
       SET review_status = 'verified', reviewer = 'admin-session',
           reviewed_at = clock_timestamp()
     WHERE id = v_evidence_id;
    RAISE EXCEPTION 'empty reason incorrectly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  SELECT count(*) INTO rows_seen FROM vns.evidence_review_events WHERE evidence_id = v_evidence_id;
  IF rows_seen <> 0 THEN RAISE EXCEPTION 'failed review left event'; END IF;

  INSERT INTO vns.editor_accounts(username,display_name,role,password_hash)
  VALUES (
    'ci_editor', 'CI Test Editor', 'reviewer',
    'scrypt$' || repeat('a',32) || '$' || repeat('b',128)
  ) RETURNING id INTO account_id;
  IF EXISTS (SELECT 1 FROM vns.editor_accounts WHERE id = account_id AND active) THEN
    RAISE EXCEPTION 'new editor was activated by default';
  END IF;

  UPDATE vns.research_evidence
    SET review_status = 'disputed', reviewer = 'admin-session',
        review_reason = v_reason, reviewed_at = clock_timestamp()
  WHERE id = v_evidence_id;

  SELECT count(*) INTO rows_seen FROM vns.evidence_review_events
   WHERE evidence_id = v_evidence_id AND editor_id IS NULL
     AND reviewer_label = 'admin-session'
     AND before_status = 'candidate' AND after_status = 'disputed'
     AND reason = v_reason;
  IF rows_seen <> 1 THEN RAISE EXCEPTION 'atomic review audit missing'; END IF;

  BEGIN
    UPDATE vns.evidence_review_events SET reason = 'Fake revised review rationale'
     WHERE evidence_id = v_evidence_id;
    RAISE EXCEPTION 'audit update incorrectly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  BEGIN
    DELETE FROM vns.evidence_review_events WHERE evidence_id = v_evidence_id;
    RAISE EXCEPTION 'audit deletion incorrectly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  BEGIN
    UPDATE vns.research_evidence SET review_status = 'verified' WHERE id = v_evidence_id;
    RAISE EXCEPTION 'review verdict overwritten';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  SELECT count(*) INTO rows_seen FROM vns.evidence_review_events WHERE evidence_id = v_evidence_id;
  IF rows_seen <> 1 THEN RAISE EXCEPTION 'review created duplicate events'; END IF;
END;
$audit_test$;
ROLLBACK;
