-- P1-07 / 0002: transactional PostgreSQL ledger for at-least-once queue delivery.
-- Offline migration. NEVER apply on the VPS without an explicit data/backup approval.
BEGIN;

CREATE TABLE vns.job_outbox (
  job_id uuid PRIMARY KEY REFERENCES vns.jobs(id) ON DELETE RESTRICT,
  queue_job_id text NOT NULL UNIQUE,
  delivery_state text NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'enqueued')),
  dispatch_attempts integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  last_attempt_at timestamptz,
  enqueued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_queue_job_id_deterministic
    CHECK (queue_job_id = 'job-' || replace(job_id::text, '-', '')),
  CONSTRAINT outbox_enqueued_timestamp
    CHECK (
      (delivery_state = 'pending' AND enqueued_at IS NULL)
      OR (delivery_state = 'enqueued' AND enqueued_at IS NOT NULL)
    )
);

CREATE INDEX job_outbox_pending_idx
  ON vns.job_outbox (created_at, job_id)
  WHERE delivery_state = 'pending';

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON vns.job_outbox
  FOR EACH ROW EXECUTE FUNCTION vns.touch_updated_at();

-- This SECURITY INVOKER function writes the business job and its delivery
-- intent atomically. It does not connect to Redis or execute any side effects.
-- The caller must be an authorized internal service; do not expose to users.
CREATE FUNCTION vns.create_job_with_outbox(
  p_kind text,
  p_idempotency_key text,
  p_story_id uuid DEFAULT NULL,
  p_max_attempts integer DEFAULT 3
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, vns
AS $function$
DECLARE
  created_id uuid;
  existing_kind text;
  existing_story_id uuid;
  existing_max_attempts integer;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'non-empty idempotency key required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO vns.jobs (kind, story_id, idempotency_key, max_attempts)
    VALUES (p_kind, p_story_id, p_idempotency_key, p_max_attempts)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO created_id;

  IF created_id IS NULL THEN
    SELECT id, kind, story_id, max_attempts
      INTO created_id, existing_kind, existing_story_id, existing_max_attempts
    FROM vns.jobs WHERE idempotency_key = p_idempotency_key;

    IF created_id IS NULL THEN
      RAISE EXCEPTION 'idempotency conflict requires retry'
        USING ERRCODE = '40001';
    END IF;

    IF existing_kind IS DISTINCT FROM p_kind
       OR existing_story_id IS DISTINCT FROM p_story_id
       OR existing_max_attempts IS DISTINCT FROM p_max_attempts THEN
      RAISE EXCEPTION 'idempotency key reused for incompatible job'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO vns.job_outbox (job_id, queue_job_id)
    VALUES (created_id, 'job-' || replace(created_id::text, '-', ''))
    ON CONFLICT (job_id) DO NOTHING;

  RETURN created_id;
END;
$function$;

COMMENT ON TABLE vns.job_outbox IS
  'Durable intent to enqueue jobs; BullMQ transport is at-least-once, not exactly-once';
COMMENT ON FUNCTION vns.create_job_with_outbox(text, text, uuid, integer) IS
  'Internal-only transactional job/queue-intent creation with idempotency';

INSERT INTO vns.schema_migrations (version) VALUES ('0002_job_outbox');

COMMIT;
