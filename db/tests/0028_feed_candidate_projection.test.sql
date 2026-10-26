-- Exercise real, disposable PostgreSQL permissions, idempotency and provenance.
BEGIN;
INSERT INTO vns.feed_poll_state(source_id,next_eligible_at,lease_token)
VALUES('ci_projection_feed',clock_timestamp()+interval '1 hour',
  '7b028000-1111-4111-8111-111111111111');
INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES
('ci_projection_feed','https://news.example.org/projection/a',
 'Synthetic science bulletin released',clock_timestamp()-interval '2 hours'),
('ci_projection_feed','https://news.example.org/projection/b',
 'Synthetic science bulletin released',clock_timestamp()-interval '2 hours'),
('ci_projection_feed','https://news.example.org/projection/c',
 'Synthetic transport bulletin released',clock_timestamp()-interval '2 hours'),
('ci_projection_feed','https://news.example.org/projection/undated',
 'Synthetic undated bulletin rejected',NULL),
('ci_projection_feed','https://news.example.org/projection/?query=x',
 'Synthetic query bulletin rejected',clock_timestamp()-interval '2 hours');

DO $test$
BEGIN
 IF has_function_privilege('vns_api_runtime',
   'vns.project_feed_candidates(text,integer)','EXECUTE')
 OR has_function_privilege('vns_feed_poll_writer',
   'vns.project_feed_candidates(text,integer)','EXECUTE')
 OR has_table_privilege('vns_feed_project_executor',
   'vns.feed_poll_candidates','INSERT')
 OR has_table_privilege('vns_api_runtime','vns.research_articles','INSERT')
 THEN RAISE EXCEPTION 'Projection privilege boundary breached'; END IF;
END $test$;
SET ROLE vns_feed_project_executor;
DO $test$
DECLARE n integer; rejected boolean := false;
BEGIN
 SELECT vns.project_feed_candidates('ci_projection_feed',100) INTO n;
 IF n <> 3 THEN RAISE EXCEPTION 'Expected three projected links, got %',n; END IF;
 SELECT vns.project_feed_candidates('ci_projection_feed',100) INTO n;
 IF n <> 0 THEN RAISE EXCEPTION 'Projection replay created duplicates'; END IF;
 BEGIN
   PERFORM vns.project_feed_candidates('invalid source',20);
 EXCEPTION WHEN invalid_parameter_value THEN rejected := true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Invalid feed source accepted'; END IF;
 rejected := false;
 BEGIN
   INSERT INTO vns.research_claims(event_id,statement)
   VALUES('00000000-0000-4000-8000-000000000000','unauthorized claim');
 EXCEPTION WHEN insufficient_privilege THEN rejected := true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Projector inserted a claim'; END IF;
END $test$;
RESET ROLE;
DO $test$
DECLARE
  article_count integer;
  event_count integer;
  relation_count integer;
BEGIN
 SELECT count(*) INTO article_count FROM vns.research_articles
 WHERE source_key='ci_projection_feed';
 SELECT count(*) INTO event_count FROM vns.research_events
 WHERE event_fingerprint IN
 (SELECT headline_sha256 FROM vns.research_articles
   WHERE source_key='ci_projection_feed');
 SELECT count(*) INTO relation_count FROM vns.research_event_articles
 WHERE article_id IN (SELECT article_id FROM vns.research_articles
   WHERE source_key='ci_projection_feed');
 IF article_count <> 3 OR event_count <> 2 OR relation_count <> 3
 THEN RAISE EXCEPTION 'Invalid persisted feed handoff %/%/%',
   article_count,event_count,relation_count; END IF;
 IF EXISTS(SELECT 1 FROM vns.research_claims c
   JOIN vns.research_events e ON e.event_id=c.event_id
   WHERE e.event_fingerprint IN (SELECT headline_sha256 FROM vns.research_articles
     WHERE source_key='ci_projection_feed'))
 THEN RAISE EXCEPTION 'Feed projection fabricated a claim'; END IF;
END $test$;
ROLLBACK;
