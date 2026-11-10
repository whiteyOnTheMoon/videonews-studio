-- Revert only the 0065 reader; legacy 0063 inbox remains untouched.
BEGIN;
DROP FUNCTION IF EXISTS vns.named_feed_inbox_sources_page(integer);
DELETE FROM vns.schema_migrations WHERE version='0065_named_feed_inbox_sources';
COMMIT;
