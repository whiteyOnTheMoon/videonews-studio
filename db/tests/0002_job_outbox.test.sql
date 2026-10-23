-- P1-07: integration tests in disposable PostgreSQL only.
BEGIN;

DO $tests$
DECLARE
  first_id uuid;
  second_id uuid;
  row_count integer;
  original_updated timestamptz;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vns.schema_migrations WHERE version = '0002_job_outbox'
  ) THEN
    RAISE EXCEPTION 'outbox migration ledger missing';
  END IF;

  first_id := vns.create_job_with_outbox('research', 'ci-unique-job-0002');
  second_id := vns.create_job_with_outbox('research', 'ci-unique-job-0002');
  IF first_id IS DISTINCT FROM second_id THEN
    RAISE EXCEPTION 'same idempotency key allocated multiple job IDs';
  END IF;

  SELECT count(*) INTO row_count FROM vns.job_outbox WHERE job_id = first_id;
  IF row_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM vns.job_outbox
     WHERE job_id = first_id
       AND queue_job_id = 'job-' || replace(first_id::text, '-', '')
       AND delivery_state = 'pending'
       AND dispatch_attempts = 0 AND enqueued_at IS NULL
  ) THEN RAISE EXCEPTION 'transactional outbox row missing or incorrect'; END IF;

  SELECT updated_at INTO original_updated FROM vns.jobs WHERE id = first_id;
  IF vns.create_job_with_outbox('research', 'ci-unique-job-0002') <> first_id THEN
    RAISE EXCEPTION 'deduplication changed the job ID';
  END IF;
  IF (SELECT updated_at FROM vns.jobs WHERE id = first_id)
     IS DISTINCT FROM original_updated THEN
    RAISE EXCEPTION 'duplicate enqueue mutated the existing job';
  END IF;

  BEGIN
    PERFORM vns.create_job_with_outbox('render', 'ci-unique-job-0002');
    RAISE EXCEPTION 'incompatible idempotency reuse accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  BEGIN
    PERFORM vns.create_job_with_outbox('render', NULL);
    RAISE EXCEPTION 'missing idempotency key accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  BEGIN
    PERFORM vns.create_job_with_outbox('research', '   ');
    RAISE EXCEPTION 'blank idempotency key accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  BEGIN
    PERFORM vns.create_job_with_outbox('probe', 'ci-invalid-kind');
    RAISE EXCEPTION 'unapproved production job kind accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    UPDATE vns.job_outbox SET queue_job_id = 'wrong' WHERE job_id = first_id;
    RAISE EXCEPTION 'nondeterministic BullMQ job ID accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    UPDATE vns.job_outbox SET delivery_state = 'enqueued' WHERE job_id = first_id;
    RAISE EXCEPTION 'enqueued status without timestamp accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  UPDATE vns.job_outbox
    SET delivery_state = 'enqueued', dispatch_attempts = 1,
        enqueued_at = clock_timestamp(), last_attempt_at = clock_timestamp()
    WHERE job_id = first_id;

  IF NOT EXISTS (
    SELECT 1 FROM vns.job_outbox WHERE job_id = first_id
      AND delivery_state = 'enqueued' AND enqueued_at IS NOT NULL
      AND dispatch_attempts = 1
  ) THEN RAISE EXCEPTION 'outbox delivery transition failed'; END IF;

  BEGIN
    DELETE FROM vns.jobs WHERE id = first_id;
    RAISE EXCEPTION 'job with outbox intent was deleted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END;
$tests$;

ROLLBACK;
