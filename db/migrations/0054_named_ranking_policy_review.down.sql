-- Policy rows are immutable and retained; only remove the callable
-- personal gateway. Migration 0053 separately protects real review evidence.
BEGIN;
DROP FUNCTION vns.named_ranking_policy_commit(text,bigint,jsonb);
DROP FUNCTION vns.named_ranking_policy_read(text);
REVOKE INSERT ON vns.feed_ranking_policy_reviews FROM vns_p2_named_executor;
DELETE FROM vns.schema_migrations WHERE version='0054_named_ranking_policy_review';
COMMIT;
