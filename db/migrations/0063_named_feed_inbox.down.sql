-- Only approved schema rollback, never while feed/projector services run.
BEGIN;
REVOKE ALL ON FUNCTION vns.named_feed_inbox_page(integer)
  FROM vns_p2_named_client;
DROP FUNCTION vns.named_feed_inbox_page(integer);
REVOKE SELECT ON vns.feed_poll_candidates FROM vns_p2_named_executor;
DELETE FROM vns.schema_migrations WHERE version='0063_named_feed_inbox';
COMMIT;
