-- Real disposable PostgreSQL test: independent source/host approval,
-- current child-scope denial, guarded idempotence and revoked-lease rejection.
BEGIN;
INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES
('ca330001-1111-4111-8111-111111111111','ci_guarded_source','Synthetic Source Reviewer',
 'admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
('ca330002-2222-4222-8222-222222222222','ci_guarded_host','Synthetic Host Reviewer',
 'admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);
SET LOCAL ROLE vns_source_admin_writer;
DO $seed$
DECLARE
  parent jsonb := '{"id":"guard_parent","baseUrl":"https://guard.example.org/feed/",
    "access":"rss","intervalMinutes":60,"termsUrl":"https://guard.example.org/terms/",
    "usage":"metadata_only","licenseNotes":"Synthetic guarded feed metadata.",
    "status":"pending","reviewedAt":"2026-10-26"}'::jsonb;
  child jsonb := '{"id":"guard_child","baseUrl":"https://guard.example.org/feed/private/",
    "access":"rss","intervalMinutes":60,"termsUrl":"https://guard.example.org/terms/",
    "usage":"metadata_only","licenseNotes":"Synthetic denied child metadata.",
    "status":"pending","reviewedAt":"2026-10-26"}'::jsonb;
BEGIN
  IF NOT vns.admin_commit_source_registry(0,1,jsonb_build_array(parent),'guard_parent',
    'create_pending','ca330001-1111-4111-8111-111111111111',0,'2026-10-26T12:00:00Z')
  THEN RAISE EXCEPTION 'parent creation failed'; END IF;
  parent := jsonb_set(parent,'{status}','"approved"'::jsonb);
  IF NOT vns.admin_commit_source_registry(1,2,jsonb_build_array(parent),'guard_parent',
    'approve','ca330001-1111-4111-8111-111111111111',0,'2026-10-26T12:00:00Z')
  THEN RAISE EXCEPTION 'parent review failed'; END IF;
  IF NOT vns.admin_commit_source_registry(2,3,jsonb_build_array(parent,child),'guard_child',
    'create_pending','ca330001-1111-4111-8111-111111111111',0,'2026-10-26T12:00:00Z')
  THEN RAISE EXCEPTION 'child creation failed'; END IF;
  child := jsonb_set(child,'{status}','"blocked"'::jsonb);
  IF NOT vns.admin_commit_source_registry(3,4,jsonb_build_array(parent,child),'guard_child',
    'block','ca330001-1111-4111-8111-111111111111',0,'2026-10-26T12:00:00Z')
  THEN RAISE EXCEPTION 'child block failed'; END IF;
END $seed$;
RESET ROLE;
SET LOCAL ROLE vns_host_approval_writer;
DO $grant$
BEGIN
  IF NOT vns.admin_change_source_host_approval(0,4,'grant','guard.example.org',
    'Independent synthetic hostname approval for guarded feed tests.',
    'ca330002-2222-4222-8222-222222222222',0)
  THEN RAISE EXCEPTION 'independent host grant failed'; END IF;
END $grant$;
RESET ROLE;

SELECT set_config('vns.ci_guarded_source',
  (SELECT value::text FROM vns.admin_source_registry,
    LATERAL jsonb_array_elements(sources) AS value
    WHERE value->>'id'='guard_parent'),true);

DO $privileges$
BEGIN
  IF has_function_privilege('vns_feed_poll_writer',
       'vns.claim_feed_poll(text,integer)','EXECUTE')
    OR has_function_privilege('vns_feed_poll_writer',
       'vns.commit_feed_poll(text,uuid,jsonb,text,text)','EXECUTE')
    OR NOT has_function_privilege('vns_feed_poll_writer',
       'vns.claim_feed_poll_authorized(jsonb,integer)','EXECUTE')
    OR NOT has_function_privilege('vns_feed_poll_writer',
       'vns.commit_feed_poll_authorized(jsonb,uuid,jsonb,text,text)','EXECUTE')
    OR has_table_privilege('vns_feed_poll_writer','vns.admin_source_registry','SELECT')
  THEN RAISE EXCEPTION 'unguarded feed write capability remains exposed'; END IF;
END $privileges$;

SET LOCAL ROLE vns_feed_poll_writer;
DO $worker$
DECLARE
  current_source jsonb := current_setting('vns.ci_guarded_source')::jsonb;
  lease uuid;
  inserted integer;
  denied boolean := false;
BEGIN
  BEGIN
    PERFORM vns.claim_feed_poll('guard_parent',60);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'legacy claim bypass allowed'; END IF;
  SELECT token INTO lease FROM vns.claim_feed_poll_authorized(current_source,60);
  IF lease IS NULL THEN RAISE EXCEPTION 'guarded claim failed'; END IF;
  PERFORM set_config('vns.ci_guarded_lease',lease::text,true);
  IF (SELECT count(*) FROM vns.claim_feed_poll_authorized(current_source,60))<>0
  THEN RAISE EXCEPTION 'duplicate lease admitted'; END IF;
  denied:=false;
  BEGIN
    PERFORM vns.commit_feed_poll_authorized(current_source,lease,
      '[{"url":"https://guard.example.org/feed/private/restricted",
         "headline":"Blocked child scope report","publishedAt":null}]'::jsonb,NULL,NULL);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'blocked child URL persisted'; END IF;
  denied:=false;
  BEGIN
    PERFORM vns.commit_feed_poll('guard_parent',lease,'[]'::jsonb,NULL,NULL);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'legacy commit bypass allowed'; END IF;

  inserted:=vns.commit_feed_poll_authorized(current_source,lease,
    '[{"url":"https://guard.example.org/feed/report-1",
       "headline":"Synthetic transport update published","publishedAt":null}]'::jsonb,
    '"ci-cache"',NULL);
  IF inserted<>1 THEN RAISE EXCEPTION 'approved article not persisted'; END IF;
  inserted:=vns.commit_feed_poll_authorized(current_source,lease,
    '[{"url":"https://guard.example.org/feed/report-1",
       "headline":"Synthetic transport update published","publishedAt":null}]'::jsonb,
    '"ci-cache"',NULL);
  IF inserted<>0 THEN RAISE EXCEPTION 'duplicate candidate inserted'; END IF;
  denied:=false;
  BEGIN
    PERFORM vns.claim_feed_poll_authorized(
      jsonb_set(current_source,'{intervalMinutes}','30'::jsonb),60);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'altered source interval admitted'; END IF;
END $worker$;
RESET ROLE;

SET LOCAL ROLE vns_host_approval_writer;
DO $revoke$
BEGIN
  IF NOT vns.admin_change_source_host_approval(1,4,'revoke','guard.example.org',
    'Independent synthetic host revocation blocks outstanding feed leases.',
    'ca330002-2222-4222-8222-222222222222',0)
  THEN RAISE EXCEPTION 'revocation rejected'; END IF;
END $revoke$;
RESET ROLE;
SET LOCAL ROLE vns_feed_poll_writer;
DO $revoked$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM vns.commit_feed_poll_authorized(
      current_setting('vns.ci_guarded_source')::jsonb,
      current_setting('vns.ci_guarded_lease')::uuid,
      '[{"url":"https://guard.example.org/feed/report-2",
         "headline":"Post revocation article rejected","publishedAt":null}]'::jsonb,
      NULL,NULL);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'revoked lease committed'; END IF;
END $revoked$;
RESET ROLE;
DO $verify$
BEGIN
  IF (SELECT count(*) FROM vns.feed_poll_candidates)<>1
    OR NOT EXISTS (
      SELECT 1 FROM vns.feed_poll_candidates
      WHERE source_id='guard_parent'
        AND article_url='https://guard.example.org/feed/report-1'
    )
  THEN RAISE EXCEPTION 'atomic guarded persistence incorrect'; END IF;
END $verify$;
ROLLBACK;
