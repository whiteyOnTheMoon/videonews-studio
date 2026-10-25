-- P1-07: additive privilege boundaries; roles have NOLOGIN and no passwords.
-- Does not grant membership or change existing application credentials.
BEGIN;
CREATE ROLE vns_outbox_dispatch NOLOGIN NOINHERIT;
CREATE ROLE vns_job_status_sync NOLOGIN NOINHERIT;
CREATE ROLE vns_research_writer NOLOGIN NOINHERIT;
GRANT USAGE ON SCHEMA vns TO vns_outbox_dispatch, vns_job_status_sync, vns_research_writer;
GRANT SELECT ON vns.jobs TO vns_outbox_dispatch, vns_job_status_sync, vns_research_writer;
GRANT SELECT ON vns.job_outbox TO vns_outbox_dispatch, vns_job_status_sync;
GRANT UPDATE (delivery_state, enqueued_at, last_attempt_at, dispatch_attempts, updated_at)
  ON vns.job_outbox TO vns_outbox_dispatch;
GRANT UPDATE (status, attempt_count, error_code, updated_at)
  ON vns.jobs TO vns_job_status_sync;
GRANT SELECT ON vns.research_requests TO vns_research_writer;
GRANT SELECT, INSERT ON vns.research_evidence TO vns_research_writer;
-- No DELETE, TRUNCATE, review UPDATE, publication, schema CREATE or login.
INSERT INTO vns.schema_migrations (version) VALUES ('0012_runtime_least_privilege');
COMMIT;
