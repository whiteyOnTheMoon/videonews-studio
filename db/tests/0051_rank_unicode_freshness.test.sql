-- True isolated PostgreSQL-17 NFKC/Unicode and historic-snapshot tests.
-- Timestamps are synthetic. No real feed request, publisher approval or QA.
BEGIN;
DO $normalize$
BEGIN
  IF vns.rank_nfkc_words('Ｆｕｌｌｗｉｄｔｈ ＳＣＩＥＮＣＥ') IS DISTINCT FROM 'fullwidth science'
     OR vns.rank_nfkc_words('Café-Science') IS DISTINCT FROM 'café science'
     OR vns.rank_nfkc_words('hello-world') IS DISTINCT FROM 'hello world'
     OR vns.rank_nfkc_words('foobar') IS NOT DISTINCT FROM 'foo bar'
  THEN RAISE EXCEPTION 'NFKC normalization or word boundary mismatch'; END IF;
END $normalize$;
DO $permissions$
BEGIN
  IF has_function_privilege('vns_feed_poll_writer','vns.rank_nfkc_words(text)','EXECUTE')
    OR has_function_privilege('vns_api_runtime','vns.rank_nfkc_words(text)','EXECUTE')
    OR NOT has_function_privilege('vns_feed_project_executor','vns.rank_nfkc_words(text)','EXECUTE')
  THEN RAISE EXCEPTION 'Ranking normalizer privileges broadened'; END IF;
END $permissions$;

INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES
 ('fa510001-1111-4111-8111-111111111111','ci_unicode_source',
  'Unicode source reviewer','admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
 ('fa510002-2222-4222-8222-222222222222','ci_unicode_host',
  'Unicode host reviewer','admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);

SET LOCAL ROLE vns_source_admin_writer;
DO $source$
DECLARE v_old bigint;v_sources jsonb;v_record jsonb;v_at timestamptz:=clock_timestamp();
BEGIN
 SELECT revision,sources INTO v_old,v_sources FROM vns.admin_source_registry WHERE singleton=true;
 v_record:=jsonb_build_object(
   'id','ci_unicode_news','baseUrl','https://unicode.example.org/news/',
   'feedUrl','https://unicode.example.org/rss.xml',
   'access','rss','intervalMinutes',60,'termsUrl','https://unicode.example.org/terms/',
   'usage','metadata_only','licenseNotes','Synthetic Unicode metadata example only.',
   'status','pending','reviewedAt',to_char(v_at AT TIME ZONE 'UTC','YYYY-MM-DD'));
 IF NOT vns.admin_commit_source_registry(v_old,v_old+1,v_sources||jsonb_build_array(v_record),
    'ci_unicode_news','create_pending','fa510001-1111-4111-8111-111111111111',0,v_at)
 THEN RAISE EXCEPTION 'Unicode source registration failed'; END IF;
 IF NOT vns.admin_commit_source_registry(v_old+1,v_old+2,
    v_sources||jsonb_build_array(jsonb_set(v_record,'{status}','"approved"'::jsonb)),
    'ci_unicode_news','approve','fa510001-1111-4111-8111-111111111111',0,v_at)
 THEN RAISE EXCEPTION 'Unicode source review failed'; END IF;
 PERFORM set_config('vns.ci_unicode_revision',(v_old+2)::text,true);
END $source$;
RESET ROLE;
SET LOCAL ROLE vns_host_approval_writer;
DO $host$
DECLARE rev bigint;sr bigint;
BEGIN
 SELECT revision INTO rev FROM vns.admin_source_host_approvals WHERE singleton=true;
 sr:=current_setting('vns.ci_unicode_revision')::bigint;
 IF NOT vns.admin_change_source_host_approval(
  rev,sr,'grant','unicode.example.org','Independent synthetic Unicode reviewer grants this host.',
  'fa510002-2222-4222-8222-222222222222',0)
 THEN RAISE EXCEPTION 'Unicode host review failed'; END IF;
END $host$;
RESET ROLE;
UPDATE vns.editorial_profile_registry
SET revision=1, profiles='[{"id":"unicode_news","language":"en-US",
"keywords":["science"],"blockedTerms":["sponsored"],
"minIndependentSources":1,"maximumArticleAgeHours":24,"format":"briefing"}]'::jsonb
WHERE singleton=true;
INSERT INTO vns.feed_poll_state(source_id,next_eligible_at,lease_token)
VALUES ('ci_unicode_news',clock_timestamp()+interval '1 hour',
 'fa510000-3333-4333-8333-333333333333');
INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES
('ci_unicode_news','https://unicode.example.org/news/one',
 'Fullwidth ＳＣＩＥＮＣＥ breakthrough announced',clock_timestamp()-interval '23 hours'),
('ci_unicode_news','https://unicode.example.org/news/two',
 'Fullwidth ＳＣＩＥＮＣＥ breakthrough announced',clock_timestamp()-interval '23 hours');
SET LOCAL ROLE vns_feed_project_client;
DO $project$
BEGIN
 IF vns.project_approved_feed_candidates('ci_unicode_news',10)<>2
 THEN RAISE EXCEPTION 'Unicode projection missing articles'; END IF;
END $project$;
RESET ROLE;

DO $rank$
BEGIN
 IF (SELECT count(*) FROM vns.feed_event_rankings WHERE profile_id='unicode_news')<>1
 OR EXISTS(
  SELECT 1 FROM vns.feed_event_rankings
  WHERE profile_id='unicode_news' AND
  (NOT reasons ? 'keyword_matches:1' OR score<1 OR article_count<>2)
 )
 THEN RAISE EXCEPTION 'NFKC matched keyword failed to rank'; END IF;
END $rank$;
CREATE ROLE editor_ci_unicode_reader LOGIN INHERIT;
GRANT vns_p2_named_client TO editor_ci_unicode_reader;
INSERT INTO vns.editor_db_principals(login_role,editor_id,auth_version,active)
VALUES ('editor_ci_unicode_reader','fa510001-1111-4111-8111-111111111111',0,true);
SET SESSION AUTHORIZATION editor_ci_unicode_reader;
DO $read$
BEGIN
 IF (SELECT count(*) FROM vns.named_ranked_feed_page(25))<>1
 THEN RAISE EXCEPTION 'Current approved Unicode ranking is invisible'; END IF;
END $read$;
RESET SESSION AUTHORIZATION;

-- Simulate an elapsed clock in a disposable transaction by aging both
-- stored publication timestamps. Previous SQL snapshots remain stored,
-- but the named reader must reject the stale stories immediately.
UPDATE vns.research_articles
SET published_at=clock_timestamp()-interval '25 hours'
WHERE source_key='ci_unicode_news';
SET SESSION AUTHORIZATION editor_ci_unicode_reader;
DO $aged$
BEGIN
 IF (SELECT count(*) FROM vns.named_ranked_feed_page(25))<>0
 THEN RAISE EXCEPTION 'Stale historical ranking shown to Admin'; END IF;
END $aged$;
RESET SESSION AUTHORIZATION;
ROLLBACK;
