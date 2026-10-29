-- P2-01: disposable scope and identity test for separate exact RSS URL.
BEGIN;
INSERT INTO vns.editor_accounts(
 id,username,display_name,role,password_hash,active
) VALUES
('fa500001-1111-4111-8111-111111111111','ci_feed_endpoint_source',
 'Synthetic source reviewer','admin',
 'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
('fa500002-2222-4222-8222-222222222222','ci_feed_endpoint_host',
 'Synthetic host reviewer','admin',
 'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);

SET LOCAL ROLE vns_source_admin_writer;
DO $source$
DECLARE v_old bigint; v_sources jsonb;v_source jsonb;v_at timestamptz;
BEGIN
 SELECT revision,sources INTO v_old,v_sources FROM vns.admin_source_registry WHERE singleton=true;
 v_at:=clock_timestamp();
 v_source:=jsonb_build_object(
   'id','ci_feed_endpoint','baseUrl','https://docs.example.org/news/',
   'feedUrl','https://docs.example.org/rss.xml',
   'access','rss','intervalMinutes',60,'termsUrl','https://docs.example.org/terms/',
   'usage','metadata_only',
   'licenseNotes','Synthetic reviewed metadata and article links only.',
   'status','pending','reviewedAt',to_char(v_at AT TIME ZONE 'UTC','YYYY-MM-DD')
 );
 IF NOT vns.admin_commit_source_registry(v_old,v_old+1,
   v_sources||jsonb_build_array(v_source),'ci_feed_endpoint','create_pending',
   'fa500001-1111-4111-8111-111111111111',0,v_at)
 THEN RAISE EXCEPTION 'Pending source with distinct RSS failed'; END IF;
 IF NOT vns.admin_commit_source_registry(v_old+1,v_old+2,
   v_sources||jsonb_build_array(jsonb_set(v_source,'{status}','"approved"'::jsonb)),
   'ci_feed_endpoint','approve',
   'fa500001-1111-4111-8111-111111111111',0,v_at)
 THEN RAISE EXCEPTION 'Approved source with distinct RSS failed'; END IF;
 PERFORM set_config('vns.ci_feed_endpoint_source_revision',(v_old+2)::text,true);
END $source$;
RESET ROLE;

DO $host_state$
BEGIN
 PERFORM set_config('vns.ci_feed_endpoint_host_revision',
   (SELECT revision::text FROM vns.admin_source_host_approvals WHERE singleton=true),true);
END $host_state$;
SET LOCAL ROLE vns_host_approval_writer;
DO $host$
BEGIN
 IF NOT vns.admin_change_source_host_approval(
   current_setting('vns.ci_feed_endpoint_host_revision')::bigint,
   current_setting('vns.ci_feed_endpoint_source_revision')::bigint,
   'grant','docs.example.org',
   'Independent synthetic RSS host reviewer approves exact hostname.',
   'fa500002-2222-4222-8222-222222222222',0
 ) THEN RAISE EXCEPTION 'Feed host grant failed'; END IF;
END $host$;
RESET ROLE;

DO $auth$
DECLARE v_source jsonb;v_wrong jsonb;
BEGIN
 SELECT x.value INTO v_source
 FROM vns.admin_source_registry r
 CROSS JOIN LATERAL jsonb_array_elements(r.sources) x(value)
 WHERE r.singleton=true AND x.value->>'id'='ci_feed_endpoint';
 IF NOT vns.feed_runtime_source_authorized(v_source)
 THEN RAISE EXCEPTION 'Reviewed exact feed scope not authorized'; END IF;
 v_wrong:=jsonb_set(v_source,'{feedUrl}','"https://attacker.example.org/rss.xml"'::jsonb);
 IF vns.feed_runtime_source_authorized(v_wrong)
 THEN RAISE EXCEPTION 'Cross-host feed request gained permission'; END IF;
 v_wrong:=jsonb_set(v_source,'{feedUrl}','"https://docs.example.org/rss.xml?key=1"'::jsonb);
 IF vns.feed_runtime_source_authorized(v_wrong)
 THEN RAISE EXCEPTION 'Query-bearing feed URL gained permission'; END IF;
END $auth$;

-- The precise authorization record is checked again by this real projection.
INSERT INTO vns.feed_poll_state(source_id,next_eligible_at,lease_token)
VALUES('ci_feed_endpoint',clock_timestamp()+interval '1 hour',
  'fa500000-3333-4333-8333-333333333333');
INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES
('ci_feed_endpoint','https://docs.example.org/news/synthetic-study',
 'Synthetic public science research briefing example',
 clock_timestamp()-interval '1 hour');
SET LOCAL ROLE vns_feed_project_client;
DO $project$
DECLARE n integer;
BEGIN
 SELECT vns.project_approved_feed_candidates('ci_feed_endpoint',5) INTO n;
 IF n<>1 THEN RAISE EXCEPTION 'Separately reviewed feed scope cannot project articles'; END IF;
END $project$;
RESET ROLE;
DO $article$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM vns.research_articles
   WHERE source_key='ci_feed_endpoint'
   AND canonical_url='https://docs.example.org/news/synthetic-study'
 ) THEN RAISE EXCEPTION 'Article provenance not persisted'; END IF;
END $article$;

-- Check actual SQL validation path rejects cross-host endpoints on a new revision.
SET LOCAL ROLE vns_source_admin_writer;
DO $bad_source$
DECLARE v_revision bigint;v_sources jsonb;v_source jsonb;v_at timestamptz;
       rejected boolean:=false;
BEGIN
 SELECT revision,sources INTO v_revision,v_sources
 FROM vns.admin_source_registry WHERE singleton=true;
 v_at:=clock_timestamp();
 SELECT x.value INTO v_source FROM jsonb_array_elements(v_sources) x(value)
 WHERE x.value->>'id'='ci_feed_endpoint';
 v_source:=jsonb_set(jsonb_set(v_source,'{feedUrl}',
   '"https://attacker.example.org/rss.xml"'::jsonb),
   '{status}','"pending"'::jsonb);
 v_source:=jsonb_set(v_source,'{reviewedAt}',
   to_jsonb(to_char(v_at AT TIME ZONE 'UTC','YYYY-MM-DD')));
 BEGIN
   PERFORM vns.admin_commit_source_registry(v_revision,v_revision+1,
     (SELECT jsonb_agg(CASE WHEN x.value->>'id'='ci_feed_endpoint'
             THEN v_source ELSE x.value END ORDER BY x.value->>'id')
      FROM jsonb_array_elements(v_sources) x(value)),
     'ci_feed_endpoint','replace_pending',
     'fa500001-1111-4111-8111-111111111111',0,v_at);
 EXCEPTION WHEN invalid_parameter_value THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'SQL permitted cross-host RSS endpoint'; END IF;
END $bad_source$;
RESET ROLE;
ROLLBACK;
