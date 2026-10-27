-- P2-03: security, idempotency, current host approval and revoked source.
BEGIN;
INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES
('fa350001-1111-4111-8111-111111111111','ci_projection_author','Synthetic Source Approver',
 'admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
('fa350002-2222-4222-8222-222222222222','ci_projection_host','Synthetic Host Reviewer',
 'admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);

SET LOCAL ROLE vns_source_admin_writer;
DO $seed$
DECLARE src jsonb := '{"id":"ci_production_feed","baseUrl":"https://projection.example.org/feed/",
 "access":"rss","intervalMinutes":60,"termsUrl":"https://projection.example.org/terms/",
 "usage":"metadata_only","licenseNotes":"Synthetic CI feed rights only.",
 "status":"pending","reviewedAt":"2026-10-26"}'::jsonb;
BEGIN
 IF NOT vns.admin_commit_source_registry(0,1,jsonb_build_array(src),'ci_production_feed',
   'create_pending','fa350001-1111-4111-8111-111111111111',0,'2026-10-26T12:00:00Z')
 THEN RAISE EXCEPTION 'initial source commit failed'; END IF;
 IF NOT vns.admin_commit_source_registry(1,2,
   jsonb_build_array(jsonb_set(src,'{status}','"approved"'::jsonb)),
   'ci_production_feed','approve','fa350001-1111-4111-8111-111111111111',0,
   '2026-10-26T12:00:00Z') THEN
   RAISE EXCEPTION 'source approval failed'; END IF;
END $seed$;
RESET ROLE;
SET LOCAL ROLE vns_host_approval_writer;
DO $host$
BEGIN
 IF NOT vns.admin_change_source_host_approval(0,2,'grant','projection.example.org',
  'Distinct synthetic reviewer authorized feed projection.',
  'fa350002-2222-4222-8222-222222222222',0)
 THEN RAISE EXCEPTION 'host approval failed'; END IF;
END $host$;
RESET ROLE;

INSERT INTO vns.feed_poll_state(source_id,next_eligible_at,lease_token)
VALUES('ci_production_feed',clock_timestamp()+interval '1 hour',
  'fa350000-3333-4333-8333-333333333333');
INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES
('ci_production_feed','https://projection.example.org/feed/a',
 'Synthetic science briefing approved by two humans',clock_timestamp()-interval '2 hours'),
('ci_production_feed','https://projection.example.org/feed/b',
 'Synthetic science briefing approved by two humans',clock_timestamp()-interval '2 hours');

DO $least$
BEGIN
 IF has_function_privilege('vns_feed_project_client',
  'vns.project_feed_candidates(text,integer)','EXECUTE')
 OR has_table_privilege('vns_feed_project_client','vns.feed_poll_candidates','SELECT')
 OR has_table_privilege('vns_feed_project_client','vns.research_articles','INSERT')
 OR has_function_privilege('vns_feed_poll_writer',
   'vns.project_approved_feed_candidates(text,integer)','EXECUTE')
 OR has_function_privilege('vns_api_runtime',
   'vns.project_approved_feed_candidates(text,integer)','EXECUTE')
 OR NOT has_function_privilege('vns_feed_project_client',
   'vns.project_approved_feed_candidates(text,integer)','EXECUTE')
 THEN RAISE EXCEPTION 'Projection privilege boundary failed'; END IF;
END $least$;

SET LOCAL ROLE vns_feed_project_client;
DO $approved$
DECLARE count_new integer; denied boolean := false;
BEGIN
 SELECT vns.project_approved_feed_candidates('ci_production_feed',2) INTO count_new;
 IF count_new <> 2 THEN RAISE EXCEPTION 'approved projection failed %',count_new; END IF;
 SELECT vns.project_approved_feed_candidates('ci_production_feed',2) INTO count_new;
 IF count_new <> 0 THEN RAISE EXCEPTION 'duplicate source projection was replayed'; END IF;
 BEGIN
   PERFORM vns.project_feed_candidates('ci_production_feed',2);
 EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
 IF NOT denied THEN RAISE EXCEPTION 'unguarded projection callable'; END IF;
 denied := false;
 BEGIN
   SELECT count(*) INTO count_new FROM vns.research_claims;
 EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
 IF NOT denied THEN RAISE EXCEPTION 'projector can inspect claims'; END IF;
END $approved$;
RESET ROLE;

DO $count$
BEGIN
 IF (SELECT count(*) FROM vns.research_articles
     WHERE source_key='ci_production_feed') <> 2
 OR (SELECT count(*) FROM vns.research_event_articles r
     JOIN vns.research_articles a ON a.article_id=r.article_id
     WHERE a.source_key='ci_production_feed') <> 2
 OR EXISTS (SELECT 1 FROM vns.research_claims c
     JOIN vns.research_events e ON c.event_id=e.event_id
     JOIN vns.research_event_articles r ON r.event_id=e.event_id
     JOIN vns.research_articles a ON r.article_id=a.article_id
     WHERE a.source_key='ci_production_feed')
 THEN RAISE EXCEPTION 'Projection generated duplicate links or fabricated claims'; END IF;
END $count$;

-- Do not allow a formerly approved feed to project after a current revocation.
INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES('ci_production_feed','https://projection.example.org/feed/c',
 'Synthetic science item after revoked rights',clock_timestamp()-interval '1 hour');
SET LOCAL ROLE vns_host_approval_writer;
DO $revoke$
BEGIN
 IF NOT vns.admin_change_source_host_approval(1,2,'revoke','projection.example.org',
   'Distinct human revokes access in CI.',
   'fa350002-2222-4222-8222-222222222222',0)
 THEN RAISE EXCEPTION 'host revoke failed'; END IF;
END $revoke$;
RESET ROLE;
SET LOCAL ROLE vns_feed_project_client;
DO $blocked$
DECLARE denied boolean := false;
BEGIN
 BEGIN
   PERFORM vns.project_approved_feed_candidates('ci_production_feed',100);
 EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
 IF NOT denied THEN RAISE EXCEPTION 'revoked source promoted'; END IF;
END $blocked$;
RESET ROLE;
DO $counts$
BEGIN
 IF (SELECT count(*) FROM vns.research_articles
   WHERE source_key='ci_production_feed') <> 2
 THEN RAISE EXCEPTION 'revoked candidate was projected'; END IF;
END $counts$;
ROLLBACK;
