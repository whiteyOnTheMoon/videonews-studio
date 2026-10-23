-- P1-07: immutable topic attached to a queued research request.
-- Offline-only migration; do not run on VPS without explicit backup approval.
BEGIN;

CREATE TABLE vns.research_requests (
  job_id uuid PRIMARY KEY REFERENCES vns.jobs(id) ON DELETE RESTRICT,
  topic text NOT NULL
    CHECK (char_length(topic) BETWEEN 12 AND 160)
    CHECK (topic = btrim(topic))
    CHECK (topic !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Topic is part of an idempotent submission. The existing job, outbox
-- intent and its topic must commit or roll back as a unit.
CREATE FUNCTION vns.create_research_request(
  p_idempotency_key text,
  p_topic text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, vns
AS $function$
DECLARE
  created_job_id uuid;
  saved_topic text;
BEGIN
  IF p_topic IS NULL OR
     char_length(p_topic) NOT BETWEEN 12 AND 160 OR
     p_topic IS DISTINCT FROM btrim(p_topic) OR
     p_topic ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid research topic' USING ERRCODE = '22023';
  END IF;

  created_job_id := vns.create_job_with_outbox(
    'research', p_idempotency_key, NULL, 3
  );

  INSERT INTO vns.research_requests (job_id, topic)
    VALUES (created_job_id, p_topic)
    ON CONFLICT (job_id) DO NOTHING;

  SELECT topic INTO saved_topic
    FROM vns.research_requests WHERE job_id = created_job_id;

  IF saved_topic IS DISTINCT FROM p_topic THEN
    RAISE EXCEPTION 'idempotency key reused with different topic'
      USING ERRCODE = '22023';
  END IF;

  RETURN created_job_id;
END;
$function$;

COMMENT ON FUNCTION vns.create_research_request(text, text) IS
  'Atomic, idempotent internal research topic + job + outbox intent';
INSERT INTO vns.schema_migrations (version) VALUES ('0003_research_requests');
COMMIT;
