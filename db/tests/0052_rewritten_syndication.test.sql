-- P2-03: two independently reviewed synthetic source IDs, rewritten
-- headlines and a 48-hour cutoff. True publisher independence is NOT proven.
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

UPDATE vns.editorial_profile_registry
SET revision=1,
profiles='[{"id":"bridge_news","language":"en-US","keywords":["bridge"],
"blockedTerms":[],"minIndependentSources":1,
"maximumArticleAgeHours":720,"format":"briefing"}]'::jsonb
WHERE singleton=true;
INSERT INTO vns.feed_poll_state(source_id,next_eligible_at,lease_token)
VALUES
('ci_rewrite_one',clock_timestamp()+interval '1 hour',
 'fa520000-3333-4333-8333-333333333333'),
('ci_rewrite_two',clock_timestamp()+interval '1 hour',
 'fa520000-3333-4333-8333-444444444444');
INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES
('ci_rewrite_one','https://rewrite.example.org/feed-a/bridge',
 'City council approves new river bridge project today',
 clock_timestamp()-interval '2 hours'),
('ci_rewrite_two','https://rewrite.example.org/feed-b/bridge',
 'Today city council approves new river bridge project',
 clock_timestamp()-interval '2 hours'),
('ci_rewrite_two','https://rewrite.example.org/feed-b/highway',
 'City council approves new highway road project today',
 clock_timestamp()-interval '2 hours'),
('ci_rewrite_two','https://rewrite.example.org/feed-b/old-bridge',
 'Breaking city council approves new river bridge project today',
 clock_timestamp()-interval '96 hours');

SET LOCAL ROLE vns_feed_project_client;
DO $projection$
BEGIN
 IF vns.project_approved_feed_candidates('ci_rewrite_one',10)<>1
 THEN RAISE EXCEPTION 'First article not projected'; END IF;
 IF vns.project_approved_feed_candidates('ci_rewrite_two',10)<>3
 THEN RAISE EXCEPTION 'Second source article set not projected'; END IF;
 IF vns.project_approved_feed_candidates('ci_rewrite_two',10)<>0
 THEN RAISE EXCEPTION 'Replay created duplicate article'; END IF;
END $projection$;
RESET ROLE;

DO $events$
DECLARE group_count integer;
BEGIN
 IF (SELECT count(*) FROM vns.research_articles)<>4
 OR (SELECT count(*) FROM vns.research_events)<>3
 OR (SELECT count(*) FROM vns.research_event_articles)<>4
 OR (SELECT count(*) FROM vns.feed_event_rankings
     WHERE profile_id='bridge_news')<>3
 THEN RAISE EXCEPTION 'Rewritten syndicated event grouping failed'; END IF;
 SELECT count(DISTINCT ea.event_id) INTO group_count
 FROM vns.research_event_articles ea
 JOIN vns.research_articles a ON a.article_id=ea.article_id
 WHERE a.canonical_url IN (
  'https://rewrite.example.org/feed-a/bridge',
  'https://rewrite.example.org/feed-b/bridge');
 IF group_count<>1
 THEN RAISE EXCEPTION 'Rewritten syndicated articles not joined'; END IF;
 IF NOT EXISTS (
  SELECT 1 FROM vns.feed_event_rankings r
  WHERE r.profile_id='bridge_news' AND r.article_count=2 AND r.source_count=2
    AND r.approved_for_publication=false AND
      r.reasons ? 'independent_verification_required'
 ) THEN RAISE EXCEPTION 'Metadata ranking missing grouped article'; END IF;
END $events$;
ROLLBACK;
