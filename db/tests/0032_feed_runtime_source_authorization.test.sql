-- P2-01/P2-02: isolated PostgreSQL approval, tampering and revocation checks.
BEGIN;
INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES
('ca320001-1111-4111-8111-111111111111','ci_authority_source','Synthetic Source Editor',
 'admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
('ca320002-2222-4222-8222-222222222222','ci_authority_host','Synthetic Host Reviewer',
 'admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);
SET LOCAL ROLE vns_source_admin_writer;
DO $seed$
DECLARE src jsonb := '{"id":"ci_authority_rss","baseUrl":"https://authority.example.org/feed/",
  "access":"rss","intervalMinutes":60,"termsUrl":"https://authority.example.org/terms/",
  "usage":"metadata_only","licenseNotes":"Synthetic authorization fixture only.",
  "status":"pending","reviewedAt":"2026-10-26"}'::jsonb;
BEGIN
 IF NOT vns.admin_commit_source_registry(0,1,jsonb_build_array(src),'ci_authority_rss',
   'create_pending','ca320001-1111-4111-8111-111111111111',0,'2026-10-26T12:00:00Z')
 THEN RAISE EXCEPTION 'initial source registration rejected'; END IF;
 IF NOT vns.admin_commit_source_registry(1,2,
   jsonb_build_array(jsonb_set(src,'{status}','"approved"'::jsonb)),
   'ci_authority_rss','approve','ca320001-1111-4111-8111-111111111111',0,
   '2026-10-26T12:00:00Z') THEN RAISE EXCEPTION 'source approval rejected'; END IF;
END $seed$;
RESET ROLE;
SET LOCAL ROLE vns_host_approval_writer;
DO $host$
BEGIN
 IF NOT vns.admin_change_source_host_approval(0,2,'grant','authority.example.org',
  'Distinct synthetic person independently authorizes this feed host.',
  'ca320002-2222-4222-8222-222222222222',0)
 THEN RAISE EXCEPTION 'host grant rejected'; END IF;
END $host$;
RESET ROLE;

DO $least$
BEGIN
 IF has_table_privilege('vns_feed_poll_writer','vns.admin_source_registry','SELECT')
 OR has_table_privilege('vns_feed_poll_writer','vns.admin_source_host_approvals','SELECT')
 OR has_table_privilege('vns_feed_poll_writer','vns.admin_source_host_audit','SELECT')
 OR NOT has_function_privilege('vns_feed_poll_writer',
    'vns.feed_runtime_source_authorized(jsonb)','EXECUTE')
 THEN RAISE EXCEPTION 'feed authority privileges unsafe'; END IF;
END $least$;
SET LOCAL ROLE vns_feed_poll_writer;
DO $accepted$
DECLARE src jsonb;
BEGIN
 -- Only the SQL admission function is accessible to this role.
 src := '{"id":"ci_authority_rss","baseUrl":"https://authority.example.org/feed/",
 "access":"rss","intervalMinutes":60,"termsUrl":"https://authority.example.org/terms/",
 "usage":"metadata_only","licenseNotes":"Synthetic authorization fixture only.",
 "status":"approved","reviewedAt":"2026-10-26"}'::jsonb;
 IF NOT vns.feed_runtime_source_authorized(src)
 THEN RAISE EXCEPTION 'approved source/host denied'; END IF;
 IF vns.feed_runtime_source_authorized(jsonb_set(src,'{intervalMinutes}','15'::jsonb))
 THEN RAISE EXCEPTION 'stale/tampered source fields permitted'; END IF;
 IF vns.feed_runtime_source_authorized(jsonb_set(src,'{baseUrl}',
      '"https://alternate.example.org/feed/"'::jsonb))
 THEN RAISE EXCEPTION 'different host permitted'; END IF;
 IF vns.feed_runtime_source_authorized(jsonb_set(src,'{status}','"pending"'::jsonb))
 THEN RAISE EXCEPTION 'pending source permitted'; END IF;
END $accepted$;
RESET ROLE;
SET LOCAL ROLE vns_host_approval_writer;
DO $revoke$
BEGIN
 IF NOT vns.admin_change_source_host_approval(1,2,'revoke','authority.example.org',
  'Synthetic operator revokes the independently granted hostname.',
  'ca320002-2222-4222-8222-222222222222',0)
 THEN RAISE EXCEPTION 'host revoke rejected'; END IF;
END $revoke$;
RESET ROLE;
SET LOCAL ROLE vns_feed_poll_writer;
DO $denied$
BEGIN
 IF vns.feed_runtime_source_authorized('{"id":"ci_authority_rss",
 "baseUrl":"https://authority.example.org/feed/","access":"rss","intervalMinutes":60,
 "termsUrl":"https://authority.example.org/terms/","usage":"metadata_only",
 "licenseNotes":"Synthetic authorization fixture only.","status":"approved",
 "reviewedAt":"2026-10-26"}'::jsonb)
 THEN RAISE EXCEPTION 'revoked source still authorized'; END IF;
END $denied$;
RESET ROLE;
ROLLBACK;
