-- Disposable PostgreSQL only; transaction rolls back test records.
BEGIN;
DO $tests$
DECLARE
  first_id uuid;
  repeated_id uuid;
  topic_a text := 'City transport funding analysis';
  topic_b text := 'Another transport funding analysis';
  total integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vns.schema_migrations
    WHERE version = '0003_research_requests') THEN
    RAISE EXCEPTION '0003 migration missing';
  END IF;

  first_id := vns.create_research_request('ci-topic-key-0003', topic_a);
  repeated_id := vns.create_research_request('ci-topic-key-0003', topic_a);
  IF first_id IS DISTINCT FROM repeated_id THEN
    RAISE EXCEPTION 'duplicate research request created distinct jobs';
  END IF;

  SELECT count(*) INTO total FROM vns.research_requests
    WHERE job_id = first_id AND topic = topic_a;
  IF total <> 1 THEN RAISE EXCEPTION 'topic not stored exactly once'; END IF;
  SELECT count(*) INTO total FROM vns.job_outbox WHERE job_id = first_id;
  IF total <> 1 THEN RAISE EXCEPTION 'outbox not atomic with topic'; END IF;

  BEGIN
    PERFORM vns.create_research_request('ci-topic-key-0003', topic_b);
    RAISE EXCEPTION 'reused key with different topic accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  BEGIN
    PERFORM vns.create_research_request('ci-new-blank', ' ');
    RAISE EXCEPTION 'blank topic accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  BEGIN
    PERFORM vns.create_research_request('ci-new-short', 'short');
    RAISE EXCEPTION 'short topic accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  BEGIN
    PERFORM vns.create_research_request('ci-new-long', repeat('x', 161));
    RAISE EXCEPTION 'oversized topic accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  BEGIN
    PERFORM vns.create_research_request('ci-new-newline', 'This is a' || chr(10) || 'topic');
    RAISE EXCEPTION 'control character topic accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  BEGIN
    PERFORM vns.create_research_request('ci-new-spaces', '  valid topic here  ');
    RAISE EXCEPTION 'untrimmed topic accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  SELECT count(*) INTO total FROM vns.jobs
    WHERE idempotency_key IN ('ci-new-short','ci-new-blank','ci-new-long',
                              'ci-new-newline','ci-new-spaces');
  IF total <> 0 THEN RAISE EXCEPTION 'invalid topics left partial jobs'; END IF;
END;
$tests$;
ROLLBACK;
