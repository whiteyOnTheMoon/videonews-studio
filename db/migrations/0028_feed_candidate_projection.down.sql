-- CI-only rollback, never run on a production research database.
BEGIN;
DROP FUNCTION vns.project_feed_candidates(text,integer);
REVOKE SELECT ON vns.feed_poll_candidates FROM vns_feed_project_executor;
REVOKE SELECT, INSERT ON vns.research_articles, vns.research_events,
  vns.research_event_articles FROM vns_feed_project_executor;
REVOKE USAGE ON SCHEMA vns FROM vns_feed_project_executor;
DROP ROLE vns_feed_project_executor;
DELETE FROM vns.schema_migrations WHERE version='0028_feed_candidate_projection';
COMMIT;
