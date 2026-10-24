-- Destructive CI-only reversal; not a production rollback plan.
-- Execute as the privileged migration owner and before 0006 down.
BEGIN;
DELETE FROM vns.schema_migrations
WHERE version = '0007_runtime_role_boundaries';

ALTER FUNCTION vns.capture_evidence_review_event()
  SECURITY INVOKER;
ALTER FUNCTION vns.capture_evidence_review_event()
  RESET search_path;
-- Migrations may run as postgres or vns; restore ownership to the
-- current migration operator, not a hardcoded role.
DO $restore_owner$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION vns.capture_evidence_review_event() OWNER TO %I',
    current_user
  );
END;
$restore_owner$;

REVOKE INSERT (evidence_id, editor_id, reviewer_label,
               before_status, after_status, reason, recorded_at)
  ON vns.evidence_review_events FROM vns_review_event_writer;
REVOKE UPDATE (delivery_state, dispatch_attempts, last_attempt_at, enqueued_at)
  ON vns.job_outbox FROM vns_outbox_dispatcher;
REVOKE SELECT ON vns.jobs, vns.job_outbox FROM vns_outbox_dispatcher;

REVOKE EXECUTE ON FUNCTION vns.create_research_request(text, text)
  FROM vns_api_runtime;
REVOKE EXECUTE ON FUNCTION vns.create_job_with_outbox(text, text, uuid, integer)
  FROM vns_api_runtime;
GRANT EXECUTE ON FUNCTION vns.create_research_request(text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION vns.create_job_with_outbox(text, text, uuid, integer)
  TO PUBLIC;
REVOKE UPDATE (review_status, reviewer, review_reason,
               reviewer_editor_id, reviewed_at)
  ON vns.research_evidence FROM vns_api_runtime;
REVOKE INSERT (job_id, topic) ON vns.research_requests FROM vns_api_runtime;
REVOKE INSERT (job_id, queue_job_id) ON vns.job_outbox FROM vns_api_runtime;
REVOKE INSERT (kind, story_id, idempotency_key, max_attempts)
  ON vns.jobs FROM vns_api_runtime;
REVOKE SELECT ON vns.editor_accounts, vns.jobs, vns.job_outbox,
  vns.research_requests, vns.research_evidence FROM vns_api_runtime;

REVOKE USAGE ON SCHEMA vns
  FROM vns_api_runtime, vns_outbox_dispatcher, vns_review_event_writer;
DROP ROLE vns_review_event_writer;
DROP ROLE vns_outbox_dispatcher;
DROP ROLE vns_api_runtime;
COMMIT;
