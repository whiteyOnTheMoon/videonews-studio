-- Revoke personal review entrypoints without changing immutable evidence.
BEGIN;
DROP FUNCTION vns.named_event_factor_review_commit(uuid,text,bigint,bigint,integer,integer,integer);
DROP FUNCTION vns.named_event_factor_review_read(uuid,text);
DROP FUNCTION vns.named_publisher_review_commit(text,bigint,text,integer);
DROP FUNCTION vns.named_publisher_review_read(text);
REVOKE INSERT ON vns.feed_publisher_provenance_reviews,
  vns.feed_event_factor_reviews FROM vns_p2_named_executor;
DELETE FROM vns.schema_migrations WHERE version='0055_named_provenance_event_review';
COMMIT;
