-- Never execute rollback against real production state without separate approval.
BEGIN;
DROP FUNCTION vns.project_approved_feed_candidates(text,integer);
REVOKE EXECUTE ON FUNCTION vns.feed_runtime_source_authorized(jsonb)
  FROM vns_feed_project_executor;
REVOKE SELECT,UPDATE(singleton) ON vns.admin_source_registry FROM vns_feed_project_executor;
REVOKE USAGE ON SCHEMA vns FROM vns_feed_project_client;
DROP ROLE vns_feed_project_client;
DELETE FROM vns.schema_migrations
 WHERE version='0035_approved_feed_candidate_projection';
COMMIT;
