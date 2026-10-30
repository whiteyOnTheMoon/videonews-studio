-- P2-03: two synthetically approved sources for canonical/legacy title identity.
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


-- Both source and host approvals are synthetic CI fixtures, never live rights.
UPDATE vns.editorial_profile_registry
SET revision=1,profiles='[{"id":"science_news","language":"en-US",
"keywords":["science"],"blockedTerms":[],"minIndependentSources":2,
"maximumArticleAgeHours":24,"format":"briefing"}]'::jsonb
WHERE singleton=true;
INSERT INTO vns.feed_poll_state(source_id,next_eligible_at,lease_token)
VALUES
('ci_rewrite_one',clock_timestamp()+interval '1 hour',
 'fa590000-3333-4333-8333-333333333333'),
('ci_rewrite_two',clock_timestamp()+interval '1 hour',
 'fa590000-3333-4333-8333-444444444444');

DO $vectors$
BEGIN
 IF encode(sha256(convert_to(
     vns.rank_nfkc_words('Ｆｕｌｌｗｉｄｔｈ SCIENCE: breakthrough!'),
     'UTF8')),'hex') <>
    'fa0015f57baed8e6304fad05cfcef1a889d695b8de34498c3b3997fa868038c0'
 OR encode(sha256(convert_to(
     vns.rank_nfkc_words('Science—update!'),'UTF8')),'hex') <>
    'eeb6d80ea18e1adb901e39938efc300f16037a5e7da4f5f0e5139ee410d6b16f'
 THEN RAISE EXCEPTION 'Known TypeScript SHA-256/NFKC title vectors diverged'; END IF;
 IF has_function_privilege('vns_feed_poll_writer',
   'vns.rank_nfkc_words(text)','EXECUTE')
 THEN RAISE EXCEPTION 'Publisher input gained private normalizer rights'; END IF;
END $vectors$;

-- A pre-0059 immutable article/event can have a LEGACY fingerprint while
-- containing the identical Unicode-normalized headline as a new candidate.
INSERT INTO vns.research_articles(
 source_key,canonical_url,headline,headline_sha256,published_at)
VALUES (
 'ci_rewrite_one','https://rewrite.example.org/feed-a/legacy',
 'Science: legacy research update!',
 encode(sha256(convert_to(
   lower(regexp_replace(btrim('Science: legacy research update!'),
     '[[:space:]]+',' ','g')),'UTF8')),'hex'),
 clock_timestamp()-interval '65 minutes');
INSERT INTO vns.research_events(event_fingerprint,label)
SELECT a.headline_sha256,a.headline FROM vns.research_articles a
WHERE a.canonical_url='https://rewrite.example.org/feed-a/legacy';
INSERT INTO vns.research_event_articles(event_id,article_id)
SELECT e.event_id,a.article_id
FROM vns.research_events e
JOIN vns.research_articles a ON a.headline_sha256=e.event_fingerprint
WHERE a.canonical_url='https://rewrite.example.org/feed-a/legacy';
SELECT set_config('vns.ci_legacy_event',(
 SELECT ea.event_id::text FROM vns.research_event_articles ea
 JOIN vns.research_articles a ON a.article_id=ea.article_id
 WHERE a.canonical_url='https://rewrite.example.org/feed-a/legacy'
),true);

INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES
('ci_rewrite_two','https://rewrite.example.org/feed-b/legacy',
 'SCIENCE—LEGACY research update',clock_timestamp()-interval '50 minutes'),
('ci_rewrite_one','https://rewrite.example.org/feed-a/fullwidth',
 'Ｆｕｌｌｗｉｄｔｈ SCIENCE: breakthrough!',clock_timestamp()-interval '38 minutes'),
('ci_rewrite_two','https://rewrite.example.org/feed-b/fullwidth',
 'fullwidth science breakthrough',clock_timestamp()-interval '32 minutes'),
('ci_rewrite_one','https://rewrite.example.org/feed-a/short',
 'Science—update!',clock_timestamp()-interval '20 minutes'),
('ci_rewrite_two','https://rewrite.example.org/feed-b/short',
 'science update',clock_timestamp()-interval '18 minutes');

SET LOCAL ROLE vns_feed_project_client;
DO $projection$
BEGIN
 IF vns.project_approved_feed_candidates('ci_rewrite_one',30)<>2 OR
    vns.project_approved_feed_candidates('ci_rewrite_two',30)<>3
 THEN RAISE EXCEPTION 'Expected five canonical title articles to project'; END IF;
 IF vns.project_approved_feed_candidates('ci_rewrite_one',30)<>0 OR
    vns.project_approved_feed_candidates('ci_rewrite_two',30)<>0
 THEN RAISE EXCEPTION 'Canonical re-projection not idempotent'; END IF;
END $projection$;
RESET ROLE;

DO $identity$
DECLARE legacy_digest text; canonical_digest text;
BEGIN
 IF (SELECT count(*) FROM vns.research_events)<>3
 OR (SELECT count(*) FROM vns.research_event_articles)<>6
 THEN RAISE EXCEPTION 'Canonical/legacy events did not coalesce'; END IF;
 IF (SELECT ea.event_id::text FROM vns.research_event_articles ea
     JOIN vns.research_articles a ON a.article_id=ea.article_id
     WHERE a.canonical_url='https://rewrite.example.org/feed-b/legacy')
      IS DISTINCT FROM current_setting('vns.ci_legacy_event')
 THEN RAISE EXCEPTION 'A recent immutable legacy title could not be matched'; END IF;
 SELECT headline_sha256 INTO legacy_digest FROM vns.research_articles
 WHERE canonical_url='https://rewrite.example.org/feed-a/legacy';
 SELECT headline_sha256 INTO canonical_digest FROM vns.research_articles
 WHERE canonical_url='https://rewrite.example.org/feed-b/legacy';
 IF legacy_digest=canonical_digest OR canonical_digest<>
     'b5e63fcdf36e7c2d93481e6c20af4130492631f0faf1df9478717cba3de10ac6'
 THEN RAISE EXCEPTION 'Legacy evidence was rewritten or new digest is incorrect'; END IF;
 IF (SELECT count(DISTINCT ea.event_id) FROM vns.research_event_articles ea
     JOIN vns.research_articles a ON a.article_id=ea.article_id
     WHERE a.canonical_url LIKE '%/fullwidth')<>1
 OR (SELECT count(DISTINCT ea.event_id) FROM vns.research_event_articles ea
     JOIN vns.research_articles a ON a.article_id=ea.article_id
     WHERE a.canonical_url LIKE '%/short')<>1
 THEN RAISE EXCEPTION 'Unicode or short-title canonical twins were split'; END IF;
 IF (SELECT count(*) FROM vns.feed_event_rankings
     WHERE profile_id='science_news' AND article_count=2
       AND source_count=2 AND approved_for_publication=false)<>3
 THEN RAISE EXCEPTION 'Canonical events not persisted as unpublished candidates'; END IF;
END $identity$;

-- Two identical-title event groups with 60h between their publication
-- times, followed by a middle timestamp 30h from BOTH, are ambiguous.
-- Even exact canonical fingerprints must NOT arbitrarily merge.
INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES ('ci_rewrite_one','https://rewrite.example.org/feed-a/ambiguous-old',
  'Science: independent inquiry today',clock_timestamp()-interval '90 hours');
SET LOCAL ROLE vns_feed_project_client;
DO $amb1$
BEGIN
 IF vns.project_approved_feed_candidates('ci_rewrite_one',30)<>1
 THEN RAISE EXCEPTION 'Old ambiguous candidate missing'; END IF;
END $amb1$;
RESET ROLE;

INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES ('ci_rewrite_one','https://rewrite.example.org/feed-a/ambiguous-new',
  'science independent inquiry today!',clock_timestamp()-interval '30 hours');
SET LOCAL ROLE vns_feed_project_client;
DO $amb2$
BEGIN
 IF vns.project_approved_feed_candidates('ci_rewrite_one',30)<>1
 THEN RAISE EXCEPTION 'New separated event missing'; END IF;
END $amb2$;
RESET ROLE;

INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES ('ci_rewrite_two','https://rewrite.example.org/feed-b/ambiguous-mid',
  'SCIENCE—INDEPENDENT inquiry today',clock_timestamp()-interval '60 hours');
SET LOCAL ROLE vns_feed_project_client;
DO $amb3$
BEGIN
 IF vns.project_approved_feed_candidates('ci_rewrite_two',30)<>1
 THEN RAISE EXCEPTION 'Middle ambiguous event missing'; END IF;
END $amb3$;
RESET ROLE;
DO $ambiguous$
BEGIN
 IF (SELECT count(DISTINCT ea.event_id)
     FROM vns.research_event_articles ea
     JOIN vns.research_articles a ON a.article_id=ea.article_id
     WHERE a.canonical_url LIKE '%/ambiguous-%')<>3
 THEN RAISE EXCEPTION 'Ambiguous all-pairs exact-title groups were merged'; END IF;
 IF (SELECT count(*) FROM vns.research_events)<>6
 THEN RAISE EXCEPTION 'Ambiguity created unexpected extra events'; END IF;
END $ambiguous$;

-- No historical articles/events are rewritten and this does not grant
-- verified news status, content rights or publication privileges.
ROLLBACK;
