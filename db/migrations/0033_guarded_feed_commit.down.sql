-- Roll back only after the feed worker is stopped and operator-approved.
BEGIN;
REVOKE EXECUTE ON FUNCTION vns.claim_feed_poll_authorized(jsonb,integer)
  FROM vns_feed_poll_writer;
REVOKE EXECUTE ON FUNCTION vns.commit_feed_poll_authorized(jsonb,uuid,jsonb,text,text)
  FROM vns_feed_poll_writer;
DROP FUNCTION vns.claim_feed_poll_authorized(jsonb,integer);
DROP FUNCTION vns.commit_feed_poll_authorized(jsonb,uuid,jsonb,text,text);
REVOKE EXECUTE ON FUNCTION vns.claim_feed_poll(text,integer)
  FROM vns_feed_source_authority;
REVOKE EXECUTE ON FUNCTION vns.commit_feed_poll(text,uuid,jsonb,text,text)
  FROM vns_feed_source_authority;
GRANT EXECUTE ON FUNCTION vns.claim_feed_poll(text,integer)
  TO vns_feed_poll_writer;
GRANT EXECUTE ON FUNCTION vns.commit_feed_poll(text,uuid,jsonb,text,text)
  TO vns_feed_poll_writer;
DELETE FROM vns.schema_migrations WHERE version='0033_guarded_feed_commit';
COMMIT;
