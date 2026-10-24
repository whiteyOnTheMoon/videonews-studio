-- P1-07: offline-only PostgreSQL runtime privileges. Never run on a VPS
-- without a separately approved credential, backup and migration plan.
-- All roles are NOLOGIN and have NO members. No API flags are modified.
BEGIN;

CREATE ROLE vns_api_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE vns_outbox_dispatcher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE vns_review_event_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

GRANT USAGE ON SCHEMA vns
  TO vns_api_runtime, vns_outbox_dispatcher, vns_review_event_writer;

-- Named login needs a password hash read, while jobs and review paths need
-- only selected application tables. These roles cannot administer accounts.
GRANT SELECT ON vns.editor_accounts, vns.jobs, vns.job_outbox,
  vns.research_requests, vns.research_evidence TO vns_api_runtime;

-- Both job-creation functions are SECURITY INVOKER. Their caller needs
-- precisely the INSERT and SELECT privileges used by their queries.
GRANT INSERT (kind, story_id, idempotency_key, max_attempts)
  ON vns.jobs TO vns_api_runtime;
GRANT INSERT (job_id, queue_job_id)
  ON vns.job_outbox TO vns_api_runtime;
GRANT INSERT (job_id, topic)
  ON vns.research_requests TO vns_api_runtime;
GRANT UPDATE (review_status, reviewer, review_reason,
              reviewer_editor_id, reviewed_at)
  ON vns.research_evidence TO vns_api_runtime;

-- Avoid PUBLIC invoking the internal job-creation functions.
REVOKE EXECUTE ON FUNCTION vns.create_research_request(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION vns.create_job_with_outbox(text, text, uuid, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vns.create_research_request(text, text)
  TO vns_api_runtime;
GRANT EXECUTE ON FUNCTION vns.create_job_with_outbox(text, text, uuid, integer)
  TO vns_api_runtime;

-- Transport alone may inspect the jobs/outbox and acknowledge delivery.
-- It cannot submit new jobs, change source verdicts or view editor hashes.
GRANT SELECT ON vns.jobs, vns.job_outbox TO vns_outbox_dispatcher;
GRANT UPDATE (delivery_state, dispatch_attempts, last_attempt_at, enqueued_at)
  ON vns.job_outbox TO vns_outbox_dispatcher;

-- Existing review trigger inserts audit events using invoker rights.
-- Give its function to a narrowly privileged, NOLOGIN owner rather than
-- granting API direct INSERT to the audit ledger. The fixed search_path
-- is required for SECURITY DEFINER functions.
GRANT INSERT (evidence_id, editor_id, reviewer_label,
              before_status, after_status, reason, recorded_at)
  ON vns.evidence_review_events TO vns_review_event_writer;
ALTER FUNCTION vns.capture_evidence_review_event()
  OWNER TO vns_review_event_writer;
ALTER FUNCTION vns.capture_evidence_review_event()
  SECURITY DEFINER;
ALTER FUNCTION vns.capture_evidence_review_event()
  SET search_path TO pg_catalog, vns;

COMMENT ON ROLE vns_api_runtime IS
  'Inactive runtime boundary; API still uses legacy vns connection until separate deployment approval.';
COMMENT ON ROLE vns_outbox_dispatcher IS
  'Inactive outbox delivery boundary; NOLOGIN, no queue credentials or memberships.';
COMMENT ON ROLE vns_review_event_writer IS
  'NOLOGIN owner of narrowly scoped SECURITY DEFINER review-audit trigger; no application membership.';

INSERT INTO vns.schema_migrations (version)
VALUES ('0007_runtime_role_boundaries');
COMMIT;
