-- P2-04 personal publisher and event assessment in an isolated PostgreSQL fixture.
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
SET revision=1,profiles='[{"id":"science_news","language":"en-US",
"keywords":["science"],"blockedTerms":[],"minIndependentSources":2,
"maximumArticleAgeHours":24,"format":"briefing"}]'::jsonb WHERE singleton=true;

CREATE ROLE editor_ci_ranking_metadata LOGIN INHERIT;
CREATE ROLE editor_ci_ranking_unknown LOGIN INHERIT;
GRANT vns_p2_named_client TO editor_ci_ranking_metadata,editor_ci_ranking_unknown;
INSERT INTO vns.editor_db_principals(login_role,editor_id,auth_version,active)
VALUES ('editor_ci_ranking_metadata','fa520001-1111-4111-8111-111111111111',0,true);
INSERT INTO vns.feed_ranking_policy_reviews(
 profile_id,profile_revision,revision,minimum_publisher_groups,
 relevance_weight,freshness_weight,quality_weight,explanatory_weight,
 visualizability_weight,risk_weight,maximum_risk,reviewer_id
) VALUES ('science_news',1,1,2,10,20,15,5,30,20,3,
 'fa520002-2222-4222-8222-222222222222');
INSERT INTO vns.feed_poll_state(source_id,next_eligible_at,lease_token) VALUES
('ci_rewrite_one',clock_timestamp()+interval '1 hour',
 'fa550000-3333-4333-8333-333333333333'),
('ci_rewrite_two',clock_timestamp()+interval '1 hour',
 'fa550000-3333-4333-8333-444444444444');
INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES
('ci_rewrite_one','https://rewrite.example.org/feed-a/science',
 'Science breakthrough discovered in laboratory today',
 clock_timestamp()-interval '2 hours'),
('ci_rewrite_two','https://rewrite.example.org/feed-b/science',
 'Science breakthrough discovered in laboratory today',
 clock_timestamp()-interval '2 hours');
SET LOCAL ROLE vns_feed_project_client;
DO $project$
BEGIN
 IF vns.project_approved_feed_candidates('ci_rewrite_one',10)<>1
    OR vns.project_approved_feed_candidates('ci_rewrite_two',10)<>1
 THEN RAISE EXCEPTION 'Synthetic source projection missing'; END IF;
END $project$;
RESET ROLE;
DO $boundaries$
BEGIN
 IF has_table_privilege('vns_p2_named_client',
       'vns.feed_publisher_provenance_reviews','INSERT')
    OR has_table_privilege('vns_api_runtime',
       'vns.feed_event_factor_reviews','INSERT')
    OR has_table_privilege('vns_feed_project_client',
       'vns.feed_event_factor_reviews','INSERT')
 THEN RAISE EXCEPTION 'Client could forge metadata reviews'; END IF;
END $boundaries$;
-- Only the disposable CI administrator resolves the event ID.
-- The named client must not receive raw research_events SELECT privileges.
SELECT set_config('vns.ci_review_event_id',
  (SELECT event_id::text FROM vns.research_events LIMIT 1),true);
SET SESSION AUTHORIZATION editor_ci_ranking_metadata;
DO $named$
DECLARE
 p_rev bigint;
 p_group text;
 p_quality integer;
 is_reviewed boolean;
 e uuid;
 rev bigint;
 pol bigint;
 explanation integer;
 visual integer;
 risk_level integer;
 refused boolean;
BEGIN
 SELECT x.source_revision,x.reviewed,x.publisher_group,x.quality
 INTO p_rev,is_reviewed,p_group,p_quality
 FROM vns.named_publisher_review_read('ci_rewrite_one') x;
 IF p_rev IS NULL OR is_reviewed OR p_group IS NOT NULL OR p_quality IS NOT NULL
 THEN RAISE EXCEPTION 'Unexpected publisher review state'; END IF;
 IF NOT vns.named_publisher_review_commit(
   'ci_rewrite_one',p_rev,'research_alpha',4)
 THEN RAISE EXCEPTION 'Named publisher provenance write failed'; END IF;
 IF NOT vns.named_publisher_review_commit(
   'ci_rewrite_two',p_rev,'research_beta',5)
 THEN RAISE EXCEPTION 'Independent second publisher review failed'; END IF;
 IF vns.named_publisher_review_commit(
   'ci_rewrite_one',p_rev,'forged_replacement',5)
 THEN RAISE EXCEPTION 'Publisher provenance overwritten'; END IF;
 IF vns.named_publisher_review_commit(
   'ci_rewrite_one',p_rev-1,'forged_replacement',5)
 THEN RAISE EXCEPTION 'Stale source revision accepted'; END IF;
 SELECT x.reviewed,x.publisher_group,x.quality INTO is_reviewed,p_group,p_quality
 FROM vns.named_publisher_review_read('ci_rewrite_one') x;
 IF NOT is_reviewed OR p_group<>'research_alpha' OR p_quality<>4
 THEN RAISE EXCEPTION 'Personal provenance not persisted'; END IF;

 e:=current_setting('vns.ci_review_event_id')::uuid;
 SELECT x.profile_revision,x.policy_revision,x.reviewed,
   x.explanatory_value,x.visualizability,x.risk
 INTO rev,pol,is_reviewed,explanation,visual,risk_level
 FROM vns.named_event_factor_review_read(e,'science_news') x;
 IF rev<>1 OR pol<>1 OR is_reviewed
 THEN RAISE EXCEPTION 'Unexpected factor review state'; END IF;
 IF NOT vns.named_event_factor_review_commit(e,'science_news',1,1,4,5,1)
 THEN RAISE EXCEPTION 'Event review not recorded'; END IF;
 IF vns.named_event_factor_review_commit(e,'science_news',1,1,5,5,0)
 THEN RAISE EXCEPTION 'Event review rewritten'; END IF;
 SELECT x.reviewed,x.explanatory_value,x.visualizability,x.risk
 INTO is_reviewed,explanation,visual,risk_level
 FROM vns.named_event_factor_review_read(e,'science_news') x;
 IF NOT is_reviewed OR explanation<>4 OR visual<>5 OR risk_level<>1
 THEN RAISE EXCEPTION 'Event factors not persisted'; END IF;

 refused:=false;
 BEGIN
  PERFORM vns.named_publisher_review_commit(
    'ci_rewrite_two',p_rev,'research_new',6);
 EXCEPTION WHEN invalid_parameter_value THEN refused:=true; END;
 IF NOT refused THEN RAISE EXCEPTION 'Over-range publisher quality accepted'; END IF;
 refused:=false;
 BEGIN
  PERFORM vns.named_event_factor_review_commit(e,'science_news',1,1,5,5,6);
 EXCEPTION WHEN invalid_parameter_value THEN refused:=true; END;
 IF NOT refused THEN RAISE EXCEPTION 'Over-range event risk accepted'; END IF;
 refused:=false;
 BEGIN
  INSERT INTO vns.feed_event_factor_reviews(event_id,profile_id,profile_revision,
    policy_revision,explanatory_value,visualizability,risk,reviewer_id)
   VALUES(e,'science_news',1,2,4,5,1,
    'fa520001-1111-4111-8111-111111111111');
 EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
 IF NOT refused THEN RAISE EXCEPTION 'Direct factor write permitted'; END IF;
END $named$;
RESET SESSION AUTHORIZATION;

DO $attribution$
BEGIN
 IF (SELECT count(*) FROM vns.feed_publisher_provenance_reviews
     WHERE reviewer_id='fa520001-1111-4111-8111-111111111111')<>2 OR
    (SELECT count(*) FROM vns.feed_event_factor_reviews
     WHERE reviewer_id='fa520001-1111-4111-8111-111111111111')<>1
 THEN RAISE EXCEPTION 'Personal provenance not attributed'; END IF;
END $attribution$;
SET LOCAL ROLE vns_feed_project_client;
DO $rerank$
BEGIN
 IF vns.project_approved_feed_candidates('ci_rewrite_one',10)<>0
 THEN RAISE EXCEPTION 'Metadata rerank unexpectedly inserted article'; END IF;
END $rerank$;
RESET ROLE;
DO $weighted$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM vns.feed_event_rankings
  WHERE profile_id='science_news' AND policy_revision=1
    AND reasons ? 'publisher_groups:2'
    AND reasons ? 'risk_level:1'
    AND reasons ? 'visualizability_level:5'
    AND approved_for_publication=false
 ) THEN RAISE EXCEPTION 'Personal reviews not propagated to weighted SQL rank'; END IF;
END $weighted$;
SET SESSION AUTHORIZATION editor_ci_ranking_unknown;
DO $unknown$
DECLARE denied boolean:=false;
BEGIN
 BEGIN PERFORM * FROM vns.named_publisher_review_read('ci_rewrite_one');
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Unknown reader was authorized'; END IF;
 denied:=false;
 BEGIN PERFORM vns.named_event_factor_review_commit(
   '11111111-1111-4111-8111-111111111111','science_news',1,1,4,5,1);
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Unknown factor reviewer authorized'; END IF;
END $unknown$;
RESET SESSION AUTHORIZATION;
-- Disabled principal cannot continue writing with same physical LOGIN.
UPDATE vns.editor_db_principals SET active=false
WHERE login_role='editor_ci_ranking_metadata';
SET SESSION AUTHORIZATION editor_ci_ranking_metadata;
DO $inactive$
DECLARE denied boolean:=false;
BEGIN
 BEGIN PERFORM vns.named_publisher_review_commit(
  'ci_rewrite_one',1,'research_alpha',4);
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Deactivated reviewer bypassed revocation'; END IF;
END $inactive$;
RESET SESSION AUTHORIZATION;
ROLLBACK;
