-- Disposable CI-only reversal. Do not execute on production storage.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version='0019_feed_poll_contract';
DROP FUNCTION vns.commit_feed_poll(text,uuid,jsonb,text,text);
DROP FUNCTION vns.claim_feed_poll(text,integer);
DROP TABLE vns.feed_poll_candidates;
DROP TABLE vns.feed_poll_state;
REVOKE USAGE ON SCHEMA vns FROM vns_feed_poll_writer, vns_feed_poll_executor;
DROP ROLE vns_feed_poll_writer;
DROP ROLE vns_feed_poll_executor;
COMMIT;
