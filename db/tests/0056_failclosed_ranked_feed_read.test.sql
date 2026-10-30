-- P2-A 0056: live named Admin read must reject stale membership and
-- publisher counts, even when an older persisted score remains in PostgreSQL.
-- P2-04: source IDs alone never attest publishers. Independent metadata
-- factors and source provenance are supplied only by DBA in disposable CI.
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
profiles='[{"id":"science_news","language":"en-US","keywords":["science"],
"blockedTerms":[],"minIndependentSources":2,
"maximumArticleAgeHours":24,"format":"briefing"}]'::jsonb
WHERE singleton=true;
INSERT INTO vns.feed_poll_state(source_id,next_eligible_at,lease_token)
VALUES
('ci_rewrite_one',clock_timestamp()+interval '1 hour',
 'fa530000-3333-4333-8333-333333333333'),
('ci_rewrite_two',clock_timestamp()+interval '1 hour',
 'fa530000-3333-4333-8333-444444444444');
INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES
('ci_rewrite_one','https://rewrite.example.org/feed-a/science',
 'Important science discovery announced this morning',
 clock_timestamp()-interval '2 hours'),
('ci_rewrite_two','https://rewrite.example.org/feed-b/science',
 'Important science discovery announced this morning',
 clock_timestamp()-interval '2 hours');
DO $least$
BEGIN
 IF has_table_privilege('vns_feed_poll_writer','vns.feed_ranking_policy_reviews','INSERT')
    OR has_table_privilege('vns_feed_project_client','vns.feed_publisher_provenance_reviews','INSERT')
    OR has_table_privilege('vns_p2_named_client','vns.feed_event_factor_reviews','INSERT')
 THEN RAISE EXCEPTION 'Untrusted feed/editor can forge weighted ranking input'; END IF;
END $least$;
SET LOCAL ROLE vns_feed_project_client;
DO $project$
BEGIN
 IF vns.project_approved_feed_candidates('ci_rewrite_one',10)<>1
    OR vns.project_approved_feed_candidates('ci_rewrite_two',10)<>1
 THEN RAISE EXCEPTION 'Synthetic metadata was not projected'; END IF;
END $project$;
RESET ROLE;
DO $initial$
BEGIN
 IF (SELECT count(*) FROM vns.feed_event_rankings
      WHERE profile_id='science_news' AND policy_revision IS NULL)<>1
 THEN RAISE EXCEPTION 'Legacy metadata-only ranking unexpectedly hidden'; END IF;
END $initial$;

-- Independent provenance and event factors are explicitly DBA-owned.
INSERT INTO vns.feed_ranking_policy_reviews(
 profile_id,profile_revision,revision,minimum_publisher_groups,
 relevance_weight,freshness_weight,quality_weight,explanatory_weight,
 visualizability_weight,risk_weight,maximum_risk,reviewer_id)
VALUES ('science_news',1,1,2,10,20,15,5,30,20,3,
  'fa520002-2222-4222-8222-222222222222');
INSERT INTO vns.feed_publisher_provenance_reviews(
 source_id,source_revision,publisher_group,quality,reviewer_id)
SELECT id,(SELECT revision FROM vns.admin_source_registry WHERE singleton=true),
       publisher,quality,'fa520002-2222-4222-8222-222222222222'::uuid
FROM (VALUES ('ci_rewrite_one','science_origin_alpha',4),
             ('ci_rewrite_two','science_origin_beta',5)) AS src(id,publisher,quality);
INSERT INTO vns.feed_event_factor_reviews(
 event_id,profile_id,profile_revision,policy_revision,
 explanatory_value,visualizability,risk,reviewer_id)
SELECT e.event_id,'science_news',1,1,4,5,1,
  'fa520002-2222-4222-8222-222222222222'::uuid
FROM vns.research_events e;

SET LOCAL ROLE vns_feed_project_client;
DO $rerank$
BEGIN
 IF vns.project_approved_feed_candidates('ci_rewrite_one',10)<>0
 THEN RAISE EXCEPTION 'Re-ranking created duplicate article'; END IF;
END $rerank$;
RESET ROLE;
DO $weighted$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM vns.feed_event_rankings
  WHERE profile_id='science_news' AND policy_revision=1
    AND score BETWEEN 60 AND 85 AND article_count=2 AND source_count=2
    AND approved_for_publication=false
    AND reasons ? 'metadata_weighted_candidate_only'
    AND reasons ? 'publisher_groups:2'
    AND reasons ? 'visualizability_level:5'
    AND reasons ? 'risk_level:1'
 ) THEN RAISE EXCEPTION 'Weighted publisher/risk/visual scoring unavailable'; END IF;
END $weighted$;

CREATE ROLE editor_ci_rank_guard LOGIN INHERIT;
GRANT vns_p2_named_client TO editor_ci_rank_guard;
INSERT INTO vns.editor_db_principals(login_role,editor_id,auth_version,active)
VALUES ('editor_ci_rank_guard','fa520001-1111-4111-8111-111111111111',0,true);

SET SESSION AUTHORIZATION editor_ci_rank_guard;
DO $baseline$
BEGIN
 IF (SELECT count(*) FROM vns.named_ranked_feed_page(25))<>1
 THEN RAISE EXCEPTION 'Current approved weighted candidate not visible'; END IF;
END $baseline$;
RESET SESSION AUTHORIZATION;

-- Model a historical ranking snapshot no longer matching event membership.
-- The source has NOT been re-ranked. A read must fail closed without
-- rewriting historical ranking evidence or weakening source approvals.
UPDATE vns.feed_event_rankings
SET article_count=article_count+1
WHERE profile_id='science_news' AND policy_revision=1;
SET SESSION AUTHORIZATION editor_ci_rank_guard;
DO $article_stale$
BEGIN
 IF EXISTS(SELECT 1 FROM vns.named_ranked_feed_page(25))
 THEN RAISE EXCEPTION 'Outdated article-count snapshot became visible'; END IF;
END $article_stale$;
RESET SESSION AUTHORIZATION;
UPDATE vns.feed_event_rankings
SET article_count=article_count-1
WHERE profile_id='science_news' AND policy_revision=1;

UPDATE vns.feed_event_rankings
SET source_count=source_count-1
WHERE profile_id='science_news' AND policy_revision=1;
SET SESSION AUTHORIZATION editor_ci_rank_guard;
DO $source_stale$
BEGIN
 IF EXISTS(SELECT 1 FROM vns.named_ranked_feed_page(25))
 THEN RAISE EXCEPTION 'Outdated source-count snapshot became visible'; END IF;
END $source_stale$;
RESET SESSION AUTHORIZATION;
UPDATE vns.feed_event_rankings
SET source_count=source_count+1
WHERE profile_id='science_news' AND policy_revision=1;

SET SESSION AUTHORIZATION editor_ci_rank_guard;
DO $restored$
BEGIN
 IF (SELECT count(*) FROM vns.named_ranked_feed_page(25))<>1
 THEN RAISE EXCEPTION 'Correct stored membership did not recover'; END IF;
END $restored$;
RESET SESSION AUTHORIZATION;

-- A newer reviewed policy requires three independently reviewed publisher
-- groups. Two distinct source IDs and two distinct publisher groups do not
-- satisfy it. Seed a stale ranking snapshot to explicitly check the READ
-- contract rather than trusting only the next project/score run.
INSERT INTO vns.feed_ranking_policy_reviews(
 profile_id,profile_revision,revision,minimum_publisher_groups,
 relevance_weight,freshness_weight,quality_weight,explanatory_weight,
 visualizability_weight,risk_weight,maximum_risk,reviewer_id
) VALUES ('science_news',1,2,3,10,20,15,5,30,20,3,
 'fa520002-2222-4222-8222-222222222222');
INSERT INTO vns.feed_event_factor_reviews(
 event_id,profile_id,profile_revision,policy_revision,
 explanatory_value,visualizability,risk,reviewer_id
) SELECT e.event_id,'science_news',1,2,4,5,1,
 'fa520002-2222-4222-8222-222222222222'::uuid
 FROM vns.research_events e;
-- Before re-ranking, old policy revision must never be shown.
SET SESSION AUTHORIZATION editor_ci_rank_guard;
DO $old_policy$
BEGIN
 IF EXISTS(SELECT 1 FROM vns.named_ranked_feed_page(25))
 THEN RAISE EXCEPTION 'Old policy snapshot incorrectly visible'; END IF;
END $old_policy$;
RESET SESSION AUTHORIZATION;
-- CI-only injection: emulate an erroneous stored projection for the latest
-- policy while independently verified publisher group threshold is unmet.
UPDATE vns.feed_event_rankings SET policy_revision=2
WHERE profile_id='science_news' AND policy_revision=1;
SET SESSION AUTHORIZATION editor_ci_rank_guard;
DO $independence$
BEGIN
 IF EXISTS(SELECT 1 FROM vns.named_ranked_feed_page(25))
 THEN RAISE EXCEPTION 'Two publishers bypassed a three-publisher policy'; END IF;
END $independence$;
RESET SESSION AUTHORIZATION;

-- Current policy rejection never mutates historical scores and no candidate
-- can be upgraded into an approved-for-publication state by the read.
DO $conclusion$
BEGIN
 IF (SELECT count(*) FROM vns.feed_event_rankings
   WHERE profile_id='science_news' AND policy_revision=2
     AND approved_for_publication=false)<>1
 THEN RAISE EXCEPTION 'Historical metadata result unexpectedly modified'; END IF;
END $conclusion$;
ROLLBACK;
