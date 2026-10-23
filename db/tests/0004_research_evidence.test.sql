-- Disposable CI only. Candidate evidence must NOT be auto-verified.
BEGIN;
DO $test$
DECLARE
  created_job_id uuid;
  evidence_id uuid;
  total integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vns.schema_migrations
    WHERE version='0004_research_evidence') THEN
    RAISE EXCEPTION 'evidence migration ledger missing';
  END IF;

  created_job_id := vns.create_research_request(
    'ci-source-evidence-job', 'Local public infrastructure accountability research'
  );

  INSERT INTO vns.research_evidence
      (job_id, source_url, publisher, headline, claim_text)
  VALUES
      (created_job_id, 'https://www.example.org/report/transport',
       'Example Publisher', 'Annual transport accountability report',
       'The report lists regional transport funding priorities.')
  RETURNING id INTO evidence_id;

  IF NOT EXISTS (SELECT 1 FROM vns.research_evidence
    WHERE id = evidence_id AND review_status = 'candidate'
      AND reviewer IS NULL AND reviewed_at IS NULL)
  THEN RAISE EXCEPTION 'evidence was falsely auto-verified'; END IF;

  BEGIN
    INSERT INTO vns.research_evidence
      (job_id, source_url, publisher, headline, claim_text, review_status)
    VALUES (created_job_id, 'https://www.example.org/article',
      'Example Publisher', 'Another sourced report',
      'A concrete statement requires human review.', 'verified');
    RAISE EXCEPTION 'verified evidence accepted without reviewer';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    UPDATE vns.research_evidence SET source_url='https://www.example.org/changed'
      WHERE id=evidence_id;
    RAISE EXCEPTION 'candidate source identity mutated';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  BEGIN
    INSERT INTO vns.research_evidence
      (job_id, source_url, publisher, headline, claim_text)
    VALUES (created_job_id, 'http://127.0.0.1/private',
      'Local Test', 'Unsafe source example title',
      'This invalid evidence candidate should fail.');
    RAISE EXCEPTION 'insecure non-HTTPS source accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  UPDATE vns.research_evidence
    SET review_status='verified', reviewer='ci-editor',
        reviewed_at=clock_timestamp() WHERE id=evidence_id;

  IF NOT EXISTS (SELECT 1 FROM vns.research_evidence
    WHERE id=evidence_id AND review_status='verified'
      AND reviewer='ci-editor' AND reviewed_at IS NOT NULL)
  THEN RAISE EXCEPTION 'explicit review metadata missing'; END IF;

  BEGIN
    UPDATE vns.research_evidence SET review_status='rejected',
      reviewer='another-reviewer' WHERE id=evidence_id;
    RAISE EXCEPTION 'reviewed evidence could be rewritten';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  SELECT count(*) INTO total FROM vns.research_evidence WHERE job_id=created_job_id;
  IF total <> 1 THEN RAISE EXCEPTION 'invalid evidence rows were retained'; END IF;
END;
$test$;
ROLLBACK;
