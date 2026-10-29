-- P2-01..04 disposable real-PostgreSQL acceptance: approved feed -> persisted ranking.
BEGIN;
INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES
('fa490001-1111-4111-8111-111111111111','ci_rank_source','Synthetic Ranking Source Reviewer',
 'admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
('fa490002-2222-4222-8222-222222222222','ci_rank_host','Synthetic Ranking Host Approver',
 'admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);
SET LOCAL ROLE vns_source_admin_writer;
DO $setup$
DECLARE v_old bigint;v_previous jsonb;
 src jsonb := '{"id":"ci_rank_feed","baseUrl":"https://ranking.example.org/feed/",
"access":"rss","intervalMinutes":60,"termsUrl":"https://ranking.example.org/terms/",
"usage":"metadata_only","licenseNotes":"Synthetic only.",
"status":"pending","reviewedAt":"2026-10-26"}'::jsonb;
BEGIN
 SELECT revision,sources INTO v_old,v_previous FROM vns.admin_source_registry WHERE singleton=true;
 IF NOT vns.admin_commit_source_registry(
   v_old,v_old+1,v_previous||jsonb_build_array(src),'ci_rank_feed',
   'create_pending','fa490001-1111-4111-8111-111111111111',0,'2026-10-26T12:00:00Z')
 THEN RAISE EXCEPTION 'Ranking source pending stage failed'; END IF;
 IF NOT vns.admin_commit_source_registry(v_old+1,v_old+2,
   v_previous||jsonb_build_array(jsonb_set(src,'{status}','"approved"'::jsonb)),
   'ci_rank_feed','approve','fa490001-1111-4111-8111-111111111111',0,
   '2026-10-26T12:00:00Z') THEN
   RAISE EXCEPTION 'Ranking source approval failed'; END IF;
END $setup$;
RESET ROLE;
SELECT set_config('vns.ci_source_revision',
  (SELECT revision::text FROM vns.admin_source_registry WHERE singleton=true),true);
SELECT set_config('vns.ci_host_revision',
  (SELECT revision::text FROM vns.admin_source_host_approvals WHERE singleton=true),true);
SET LOCAL ROLE vns_host_approval_writer;
DO $host$
DECLARE v_host bigint;v_source bigint;
BEGIN
 v_host:=current_setting('vns.ci_host_revision')::bigint;
 v_source:=current_setting('vns.ci_source_revision')::bigint;
 IF NOT vns.admin_change_source_host_approval(v_host,v_source,'grant','ranking.example.org',
  'Independent synthetic ranking scope reviewer.',
  'fa490002-2222-4222-8222-222222222222',0)
 THEN RAISE EXCEPTION 'Ranking host grant failed'; END IF;
END $host$;
RESET ROLE;
UPDATE vns.editorial_profile_registry
SET revision=1,
    profiles='[{"id":"science_news","language":"en-US","keywords":["science"],
    "blockedTerms":[],"minIndependentSources":1,
    "maximumArticleAgeHours":24,"format":"briefing"},
    {"id":"blocked_news","language":"en-US","keywords":["news"],
    "blockedTerms":["science"],"minIndependentSources":1,
    "maximumArticleAgeHours":24,"format":"briefing"}]'::jsonb
WHERE singleton=true;
INSERT INTO vns.feed_poll_state(source_id,next_eligible_at,lease_token)
VALUES('ci_rank_feed',clock_timestamp()+interval '1 hour',
  'fa490000-3333-4333-8333-333333333333');
INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES
('ci_rank_feed','https://ranking.example.org/feed/a',
 'Synthetic science news event for ranking review',clock_timestamp()-interval '2 hours'),
('ci_rank_feed','https://ranking.example.org/feed/b',
 'Synthetic science news event for ranking review',clock_timestamp()-interval '2 hours');

DO $privs$
BEGIN
 IF has_function_privilege('vns_feed_project_client',
   'vns.refresh_approved_feed_rankings(text,integer)','EXECUTE')
 OR has_table_privilege('vns_feed_project_client','vns.feed_event_rankings','SELECT')
 OR has_table_privilege('vns_p2_named_client','vns.feed_event_rankings','SELECT')
 OR has_function_privilege('vns_api_runtime',
   'vns.named_ranked_feed_page(integer)','EXECUTE')
 OR NOT has_function_privilege('vns_p2_named_client',
   'vns.named_ranked_feed_page(integer)','EXECUTE')
 THEN RAISE EXCEPTION 'Ranking least-privilege boundary invalid'; END IF;
END $privs$;

SET LOCAL ROLE vns_feed_project_client;
DO $project$
DECLARE n integer;
BEGIN
 SELECT vns.project_approved_feed_candidates('ci_rank_feed',10) INTO n;
 IF n<>2 THEN RAISE EXCEPTION 'Guarded projection did not ingest two articles'; END IF;
 SELECT vns.project_approved_feed_candidates('ci_rank_feed',10) INTO n;
 IF n<>0 THEN RAISE EXCEPTION 'Repeated projection created duplicates'; END IF;
END $project$;
RESET ROLE;
DO $rank$
BEGIN
 IF (SELECT count(*) FROM vns.feed_event_rankings WHERE profile_id='science_news')<>1
    OR (SELECT count(*) FROM vns.feed_event_rankings WHERE profile_id='blocked_news')<>0
    OR EXISTS(SELECT 1 FROM vns.feed_event_rankings
      WHERE approved_for_publication<>false OR score<1 OR article_count<>2
      OR source_count<>1 OR NOT reasons ? 'independent_verification_required')
 THEN RAISE EXCEPTION 'Durable ranked candidate or blocklist mismatch'; END IF;
END $rank$;
-- Reject an unauthorized session even if it has the client NOLOGIN role.
SET LOCAL ROLE vns_p2_named_client;
DO $deny$
DECLARE denied boolean:=false;
BEGIN
 BEGIN PERFORM vns.named_ranked_feed_page(25);
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Unattributed editorial read succeeded'; END IF;
END $deny$;
RESET ROLE;

-- A distinct personally authenticated PostgreSQL LOGIN can read the
-- current revision through the named function, with no raw ranking SELECT.
CREATE ROLE editor_ci_rank_reader LOGIN INHERIT;
GRANT vns_p2_named_client TO editor_ci_rank_reader;
INSERT INTO vns.editor_db_principals(login_role,editor_id,auth_version,active)
VALUES ('editor_ci_rank_reader','fa490001-1111-4111-8111-111111111111',0,true);
SET SESSION AUTHORIZATION editor_ci_rank_reader;
DO $named_read$
DECLARE n integer;
BEGIN
 SELECT count(*) INTO n FROM vns.named_ranked_feed_page(25);
 IF n<>1 THEN RAISE EXCEPTION 'Personal Admin could not read durable approved ranking'; END IF;
END $named_read$;
RESET SESSION AUTHORIZATION;

-- Revocation must prevent fresh projection, never rewrite prior approval.
SELECT set_config('vns.ci_source_revision',
  (SELECT revision::text FROM vns.admin_source_registry WHERE singleton=true),true);
SELECT set_config('vns.ci_host_revision',
  (SELECT revision::text FROM vns.admin_source_host_approvals WHERE singleton=true),true);
SET LOCAL ROLE vns_host_approval_writer;
DO $revoke$
DECLARE v_host bigint;v_source bigint;
BEGIN
 v_host:=current_setting('vns.ci_host_revision')::bigint;
 v_source:=current_setting('vns.ci_source_revision')::bigint;
 IF NOT vns.admin_change_source_host_approval(v_host,v_source,'revoke','ranking.example.org',
   'Independent synthetic ranking approval revoked.',
   'fa490002-2222-4222-8222-222222222222',0)
 THEN RAISE EXCEPTION 'Ranking host revoke failed'; END IF;
END $revoke$;
RESET ROLE;
SET SESSION AUTHORIZATION editor_ci_rank_reader;
DO $revoked_view$
DECLARE n integer;
BEGIN
 SELECT count(*) INTO n FROM vns.named_ranked_feed_page(25);
 IF n<>0 THEN RAISE EXCEPTION 'Revoked host still appears in Admin ranking'; END IF;
END $revoked_view$;
RESET SESSION AUTHORIZATION;
SET LOCAL ROLE vns_feed_project_client;
DO $reject$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN PERFORM vns.project_approved_feed_candidates('ci_rank_feed',10);
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Revoked source still projects'; END IF;
END $reject$;
RESET ROLE;
ROLLBACK;
