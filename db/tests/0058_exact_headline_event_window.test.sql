-- P2-03: two synthetically approved sources, exact-title repeat after 48 hours.
-- This test does not grant actual publisher rights or publication.
BEGIN;
DO $jaccard$
BEGIN
 IF NOT vns.rank_headlines_overlap(
   'City council approves new river bridge project today',
   'Today city council approves new river bridge project')
 OR vns.rank_headlines_overlap(
   'City council approves new river bridge project today',
   'City council approves new highway road project today')
 OR vns.rank_headlines_overlap('Short breaking news','News breaking short')
 OR NOT vns.rank_headlines_overlap(
   'Ｆｕｌｌｗｉｄｔｈ science research breakthrough announced today',
   'Today fullwidth science research breakthrough announced')
 THEN RAISE EXCEPTION 'Rewritten syndication token overlap invalid'; END IF;
 IF has_function_privilege('vns_feed_poll_writer',
      'vns.rank_headlines_overlap(text,text)','EXECUTE')
 OR NOT has_function_privilege('vns_feed_project_executor',
      'vns.rank_headlines_overlap(text,text)','EXECUTE')
 THEN RAISE EXCEPTION 'Similarity privilege widened'; END IF;
END $jaccard$;

INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES
('fa520001-1111-4111-8111-111111111111','ci_rewrite_source',
 'Rewrite synthetic source reviewer','admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
('fa520002-2222-4222-8222-222222222222','ci_rewrite_host',
 'Rewrite independent host reviewer','admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);

SET LOCAL ROLE vns_source_admin_writer;
DO $sources$
DECLARE old_rev bigint;old_sources jsonb;new_source jsonb;
 at_time timestamptz:=clock_timestamp();id text;path text;
BEGIN
 SELECT revision,sources INTO old_rev,old_sources
 FROM vns.admin_source_registry WHERE singleton=true;
 FOR id,path IN SELECT * FROM (VALUES
  ('ci_rewrite_one','feed-a'),('ci_rewrite_two','feed-b')) v(id,path)
 LOOP
  new_source:=jsonb_build_object(
    'id',id,'baseUrl','https://rewrite.example.org/'||path||'/',
    'feedUrl','https://rewrite.example.org/'||path||'/rss.xml',
    'access','rss','intervalMinutes',60,
    'termsUrl','https://rewrite.example.org/terms/',
    'usage','metadata_only',
    'licenseNotes','Synthetic syndication metadata with no real feed rights.',
    'status','pending','reviewedAt',
    to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD'));
  IF NOT vns.admin_commit_source_registry(
    old_rev,old_rev+1,old_sources||jsonb_build_array(new_source),id,
    'create_pending','fa520001-1111-4111-8111-111111111111',0,at_time
  ) THEN RAISE EXCEPTION 'Syndication pending review failed'; END IF;
  old_rev:=old_rev+1;
  old_sources:=old_sources||jsonb_build_array(new_source);
  new_source:=jsonb_set(new_source,'{status}','"approved"'::jsonb);
  IF NOT vns.admin_commit_source_registry(
    old_rev,old_rev+1,
    (SELECT jsonb_agg(CASE WHEN x.value->>'id'=id
              THEN new_source ELSE x.value END ORDER BY x.value->>'id')
      FROM jsonb_array_elements(old_sources) x(value)),id,
    'approve','fa520001-1111-4111-8111-111111111111',0,at_time
  ) THEN RAISE EXCEPTION 'Syndication source review failed'; END IF;
  old_rev:=old_rev+1;
  SELECT sources INTO old_sources
    FROM vns.admin_source_registry WHERE singleton=true;
 END LOOP;
 PERFORM set_config('vns.ci_rewrite_source_revision',old_rev::text,true);
END $sources$;
RESET ROLE;
SET LOCAL ROLE vns_host_approval_writer;
DO $host$
DECLARE rev bigint;
BEGIN
 SELECT revision INTO rev FROM vns.admin_source_host_approvals WHERE singleton=true;
 IF NOT vns.admin_change_source_host_approval(
    rev,current_setting('vns.ci_rewrite_source_revision')::bigint,
    'grant','rewrite.example.org',
    'Independent review for the synthetic same-host feed scopes.',
    'fa520002-2222-4222-8222-222222222222',0)
 THEN RAISE EXCEPTION 'Rewritten syndication host review failed'; END IF;
END $host$;
RESET ROLE;


UPDATE vns.editorial_profile_registry SET revision=1,
profiles='[{"id":"science_news","language":"en-US","keywords":["science"],
"blockedTerms":[],"minIndependentSources":2,
"maximumArticleAgeHours":24,"format":"briefing"}]'::jsonb
WHERE singleton=true;
INSERT INTO vns.feed_poll_state(source_id,next_eligible_at,lease_token)
VALUES
('ci_rewrite_one',clock_timestamp()+interval '1 hour',
 'fa580000-3333-4333-8333-333333333333'),
('ci_rewrite_two',clock_timestamp()+interval '1 hour',
 'fa580000-3333-4333-8333-444444444444');

-- Step 1: an archived exact headline is initially its own event.
INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES ('ci_rewrite_one','https://rewrite.example.org/feed-a/archive',
 'Important science discovery announced this morning',
 clock_timestamp()-interval '73 hours');
SET LOCAL ROLE vns_feed_project_client;
DO $archived$
BEGIN
 IF vns.project_approved_feed_candidates('ci_rewrite_one',10)<>1
 THEN RAISE EXCEPTION 'Archived article was not projected'; END IF;
END $archived$;
RESET ROLE;
DO $old_count$
BEGIN
 IF (SELECT count(*) FROM vns.research_events)<>1
    OR (SELECT count(*) FROM vns.research_event_articles)<>1
 THEN RAISE EXCEPTION 'Unexpected archived event count'; END IF;
END $old_count$;
SELECT set_config('vns.ci_old_event',(
 SELECT ea.event_id::text
 FROM vns.research_event_articles ea
 JOIN vns.research_articles a ON a.article_id=ea.article_id
 WHERE a.canonical_url='https://rewrite.example.org/feed-a/archive'
),true);

-- Step 2: an exact-title replay days later must NOT attach to the archive.
INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES ('ci_rewrite_one','https://rewrite.example.org/feed-a/today',
 'Important science discovery announced this morning',
 clock_timestamp()-interval '2 hours');
SET LOCAL ROLE vns_feed_project_client;
DO $fresh$
BEGIN
 IF vns.project_approved_feed_candidates('ci_rewrite_one',10)<>1
 THEN RAISE EXCEPTION 'Fresh repeated-title article was not projected'; END IF;
END $fresh$;
RESET ROLE;
SELECT set_config('vns.ci_new_event',(
 SELECT ea.event_id::text
 FROM vns.research_event_articles ea
 JOIN vns.research_articles a ON a.article_id=ea.article_id
 WHERE a.canonical_url='https://rewrite.example.org/feed-a/today'
),true);
DO $split$
DECLARE legacy text; split text;
BEGIN
 IF current_setting('vns.ci_old_event')=current_setting('vns.ci_new_event')
 THEN RAISE EXCEPTION 'Exact-title replay bypassed the 48-hour boundary'; END IF;
 IF (SELECT count(*) FROM vns.research_events)<>2
 OR (SELECT count(*) FROM vns.research_event_articles)<>2
 THEN RAISE EXCEPTION 'Separated event count invalid'; END IF;
 SELECT a.headline_sha256 INTO legacy FROM vns.research_articles a
 WHERE a.canonical_url='https://rewrite.example.org/feed-a/archive';
 IF (SELECT a.headline_sha256 FROM vns.research_articles a
 WHERE a.canonical_url='https://rewrite.example.org/feed-a/today')<>legacy
 THEN RAISE EXCEPTION 'Legacy article fingerprint was rewritten'; END IF;
 SELECT e.event_fingerprint INTO split FROM vns.research_events e
 WHERE e.event_id=current_setting('vns.ci_new_event')::uuid;
 IF split=legacy OR split !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'Repeat-title event lacks unique digest'; END IF;
END $split$;

-- Step 3: a separate approved source, close to the new article but
-- remote from the archived article, must join exactly the new event.
INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES ('ci_rewrite_two','https://rewrite.example.org/feed-b/today',
 'Important science discovery announced this morning',
 clock_timestamp()-interval '1 hour');
SET LOCAL ROLE vns_feed_project_client;
DO $syndicated$
BEGIN
 IF vns.project_approved_feed_candidates('ci_rewrite_two',10)<>1
 THEN RAISE EXCEPTION 'Syndicated fresh article missing'; END IF;
 IF vns.project_approved_feed_candidates('ci_rewrite_two',10)<>0
 THEN RAISE EXCEPTION 'Idempotent re-projection created another mapping'; END IF;
END $syndicated$;
RESET ROLE;
DO $independent_sources$
DECLARE joined uuid;
BEGIN
 SELECT ea.event_id INTO joined
 FROM vns.research_event_articles ea
 JOIN vns.research_articles a ON a.article_id=ea.article_id
 WHERE a.canonical_url='https://rewrite.example.org/feed-b/today';
 IF joined IS DISTINCT FROM current_setting('vns.ci_new_event')::uuid
 THEN RAISE EXCEPTION 'Current article did not join its 48-hour event'; END IF;
 IF (SELECT count(*) FROM vns.research_event_articles
     WHERE event_id=current_setting('vns.ci_old_event')::uuid)<>1
 OR (SELECT count(*) FROM vns.research_event_articles
     WHERE event_id=current_setting('vns.ci_new_event')::uuid)<>2
 OR (SELECT count(*) FROM vns.research_events)<>2
 THEN RAISE EXCEPTION 'Old and fresh event membership not preserved'; END IF;
 IF NOT EXISTS(
   SELECT 1 FROM vns.feed_event_rankings
   WHERE event_id=current_setting('vns.ci_new_event')::uuid
     AND profile_id='science_news' AND source_count=2
     AND article_count=2 AND approved_for_publication=false
 ) THEN RAISE EXCEPTION 'Fresh split event not durably ranked'; END IF;
 IF EXISTS(
   SELECT 1 FROM vns.feed_event_rankings
   WHERE event_id=current_setting('vns.ci_old_event')::uuid
 ) THEN RAISE EXCEPTION 'Archived replay bypassed current age limit'; END IF;
END $independent_sources$;

-- Existing event fingerprints and original evidence remain immutable.
-- No independent claim verification or publication occurs in this test.
ROLLBACK;
