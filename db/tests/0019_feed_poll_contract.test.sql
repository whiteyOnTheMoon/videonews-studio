-- P2-02: all data is synthetic; transaction rollback after assertions.
BEGIN;
DO $acl$
BEGIN
  IF (SELECT count(*) FROM vns.schema_migrations
      WHERE version='0019_feed_poll_contract')<>1
    OR (SELECT count(*) FROM vns.feed_poll_state)<>0
    OR (SELECT count(*) FROM vns.feed_poll_candidates)<>0 THEN
    RAISE EXCEPTION 'Feed schema not empty or migration missing';
  END IF;
  IF NOT has_function_privilege('vns_feed_poll_writer',
       'vns.claim_feed_poll(text,integer)','EXECUTE')
    OR NOT has_function_privilege('vns_feed_poll_writer',
       'vns.commit_feed_poll(text,uuid,jsonb,text,text)','EXECUTE')
    OR has_table_privilege('vns_feed_poll_writer',
       'vns.feed_poll_state','SELECT')
    OR has_table_privilege('vns_feed_poll_writer',
       'vns.feed_poll_state','INSERT')
    OR has_table_privilege('vns_feed_poll_writer',
       'vns.feed_poll_candidates','INSERT')
    OR has_function_privilege('vns_api_runtime',
       'vns.commit_feed_poll(text,uuid,jsonb,text,text)','EXECUTE')
    OR has_function_privilege('vns_research_writer',
       'vns.claim_feed_poll(text,integer)','EXECUTE')
    OR (SELECT rolcanlogin FROM pg_roles WHERE rolname='vns_feed_poll_writer')
    OR (SELECT rolcanlogin FROM pg_roles WHERE rolname='vns_feed_poll_executor')
  THEN
    RAISE EXCEPTION 'Feed privileges or NOLOGIN boundaries invalid';
  END IF;
END;
$acl$;
SET LOCAL ROLE vns_feed_poll_writer;
DO $worker$
DECLARE
  v_token uuid;
  v_new integer;
  v_denied boolean;
BEGIN
  v_denied:=false;
  BEGIN
    PERFORM 1 FROM vns.feed_poll_state;
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Feed writer can inspect internal state'; END IF;

  SELECT token INTO v_token FROM vns.claim_feed_poll('ci_feed_one',60);
  IF v_token IS NULL THEN RAISE EXCEPTION 'Initial feed claim missing'; END IF;
  PERFORM set_config('vns.ci_original_lease',v_token::text,true);
  IF (SELECT count(*) FROM vns.claim_feed_poll('ci_feed_one',60))<>0 THEN
    RAISE EXCEPTION 'Early feed claim not refused';
  END IF;
  v_new:=vns.commit_feed_poll(
    'ci_feed_one',v_token,
    '[{"url":"https://www.example.org/rss/news-1","headline":"Transport investment announced","publishedAt":null}]',
    '"synthetic-etag-1"',NULL);
  IF v_new<>1 THEN RAISE EXCEPTION 'First candidate not inserted'; END IF;
  v_new:=vns.commit_feed_poll(
    'ci_feed_one',v_token,
    '[{"url":"https://www.example.org/rss/news-1","headline":"Altered headline must never replace","publishedAt":null}]',
    '"synthetic-etag-2"',NULL);
  IF v_new<>0 THEN RAISE EXCEPTION 'Repeated feed candidate duplicated'; END IF;

  v_denied:=false;
  BEGIN
    PERFORM vns.commit_feed_poll(
      'ci_feed_one','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '[]'::jsonb,NULL,NULL);
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Forged lease accepted'; END IF;

  v_denied:=false;
  BEGIN
    PERFORM vns.commit_feed_poll('ci_feed_one',v_token,
      '[{"url":"https://www.example.org/rss/news-2","headline":"Bad metadata",
         "publishedAt":null,"content":"must never persist"}]'::jsonb,NULL,NULL);
  EXCEPTION WHEN invalid_parameter_value THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Unreviewed fulltext metadata accepted'; END IF;

  v_denied:=false;
  BEGIN
    PERFORM vns.claim_feed_poll('ci_feed_one',1);
  EXCEPTION WHEN invalid_parameter_value THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Too-frequent poll admitted'; END IF;
END;
$worker$;
RESET ROLE;
DO $verify$
BEGIN
  IF (SELECT count(*) FROM vns.feed_poll_state)<>1
    OR (SELECT count(*) FROM vns.feed_poll_candidates)<>1
    OR NOT EXISTS(SELECT 1 FROM vns.feed_poll_state
       WHERE source_id='ci_feed_one' AND etag='"synthetic-etag-2"')
    OR NOT EXISTS(SELECT 1 FROM vns.feed_poll_candidates
       WHERE source_id='ci_feed_one'
       AND headline='Transport investment announced'
       AND review_status='candidate') THEN
    RAISE EXCEPTION 'Feed lease or idempotent metadata was not persisted';
  END IF;
END;
$verify$;
-- Simulate expiry with a privileged synthetic fixture, not by worker time.
UPDATE vns.feed_poll_state
  SET next_eligible_at=clock_timestamp()-interval '1 second'
  WHERE source_id='ci_feed_one';
SET LOCAL ROLE vns_feed_poll_writer;
DO $expiry$
DECLARE
  v_fresh uuid;
  v_denied boolean := false;
BEGIN
  SELECT token INTO v_fresh FROM vns.claim_feed_poll('ci_feed_one',60);
  IF v_fresh IS NULL OR
    (SELECT count(*) FROM vns.claim_feed_poll('ci_feed_one',60))<>0 THEN
    RAISE EXCEPTION 'Expired feed claim not renewed exactly once';
  END IF;
  BEGIN
    PERFORM vns.commit_feed_poll('ci_feed_one',
      current_setting('vns.ci_original_lease')::uuid,'[]'::jsonb,NULL,NULL);
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Stale feed claim committed'; END IF;
END;
$expiry$;
RESET ROLE;
ROLLBACK;
