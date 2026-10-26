-- Real disposable PostgreSQL test of atomic distinct human approval.
BEGIN;
INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES
('ca230001-1111-4111-8111-111111111111','ci_source_reviewer','Synthetic Source Reviewer',
'admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
('ca230002-2222-4222-8222-222222222222','ci_host_granter','Synthetic Host Granter',
'admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);
SET LOCAL ROLE vns_source_admin_writer;
DO $seed$
DECLARE src jsonb := '{"id":"ci_two_person","baseUrl":"https://review.example.org/feed/",
"access":"rss","intervalMinutes":60,"termsUrl":"https://review.example.org/terms/",
"usage":"metadata_only","licenseNotes":"Synthetic rights-reviewed two-person case.",
"status":"pending","reviewedAt":"2026-10-26"}'::jsonb;
BEGIN
 IF NOT vns.admin_commit_source_registry(0,1,jsonb_build_array(src),'ci_two_person',
  'create_pending','ca230001-1111-4111-8111-111111111111',0,'2026-10-26T12:00:00Z')
 THEN RAISE EXCEPTION 'seed failed'; END IF;
 IF NOT vns.admin_commit_source_registry(1,2,
  jsonb_build_array(jsonb_set(src,'{status}','"approved"'::jsonb)),
  'ci_two_person','approve','ca230001-1111-4111-8111-111111111111',0,
  '2026-10-26T12:00:00Z') THEN RAISE EXCEPTION 'approval seed failed'; END IF;
END $seed$;
RESET ROLE;
SET LOCAL ROLE vns_host_approval_writer;
DO $verify$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN
  PERFORM vns.admin_change_source_host_approval(0,2,'grant','review.example.org',
   'Synthetic reviewer cannot grant their own source host.',
   'ca230001-1111-4111-8111-111111111111',0);
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'self-approval bypassed'; END IF;
 IF NOT vns.admin_change_source_host_approval(0,2,'grant','review.example.org',
  'Synthetic second person separately approves this hostname.',
  'ca230002-2222-4222-8222-222222222222',0)
 THEN RAISE EXCEPTION 'distinct person grant denied'; END IF;
END $verify$;
RESET ROLE;
DO $audit$
BEGIN
 IF (SELECT count(*) FROM vns.admin_source_host_audit WHERE host='review.example.org'
     AND editor_id='ca230002-2222-4222-8222-222222222222') <> 1
 OR (SELECT count(*) FROM vns.admin_source_host_audit WHERE host='review.example.org') <> 1
 THEN RAISE EXCEPTION 'dual-control audit mismatch'; END IF;
END $audit$;
ROLLBACK;
