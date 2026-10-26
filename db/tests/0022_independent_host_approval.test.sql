-- P2-01 0022: real disposable PostgreSQL actor, reason, ACL, revision and audit tests.
BEGIN;
DO $privileges$
BEGIN
  IF NOT has_function_privilege('vns_host_approval_writer',
    'vns.admin_change_source_host_approval(bigint,bigint,text,text,text,uuid,integer)','EXECUTE')
    OR has_function_privilege('vns_api_runtime',
    'vns.admin_change_source_host_approval(bigint,bigint,text,text,text,uuid,integer)','EXECUTE')
    OR has_table_privilege('vns_host_approval_writer','vns.admin_source_host_approvals','UPDATE')
    OR has_table_privilege('vns_host_approval_writer','vns.admin_source_host_audit','INSERT')
    OR has_table_privilege('vns_host_approval_writer','vns.admin_source_registry','SELECT')
    OR NOT has_table_privilege('vns_host_approval_writer','vns.admin_source_host_approvals','SELECT')
    OR (SELECT rolcanlogin FROM pg_roles WHERE rolname='vns_host_approval_writer')
    OR (SELECT rolcanlogin FROM pg_roles WHERE rolname='vns_host_approval_executor')
    OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=
       'vns.admin_change_source_host_approval(bigint,bigint,text,text,text,uuid,integer)'::regprocedure)
       <>'vns_host_approval_executor'
  THEN RAISE EXCEPTION 'host approval least privilege invalid'; END IF;
END;
$privileges$;
INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES
 ('ca220001-1111-4111-8111-111111111111','ci_host_admin','CI Host Admin',
  'admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
 ('ca220002-2222-4222-8222-222222222222','ci_host_editor','CI Host Editor',
  'editor','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);
SET LOCAL ROLE vns_host_approval_writer;
DO $deny$
DECLARE refused boolean:=false;
BEGIN
  BEGIN
    UPDATE vns.admin_source_host_approvals SET revision=99 WHERE singleton;
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'writer bypassed approval function'; END IF;
  refused:=false;
  BEGIN
    INSERT INTO vns.admin_source_host_audit
      (revision,source_revision,action,host,reason,editor_id,editor_username,editor_auth_version)
    VALUES(99,1,'grant','news.example.org','Synthetic review documentation only.',
      'ca220001-1111-4111-8111-111111111111','fake',0);
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'writer forged host audit row'; END IF;
  refused:=false;
  BEGIN
    PERFORM vns.admin_change_source_host_approval(0,1,'grant','news.example.org',
      'Reviewed metadata and terms, synthetic only.',
      'ca220002-2222-4222-8222-222222222222',0);
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'non-admin host grant accepted'; END IF;
  refused:=false;
  BEGIN
    PERFORM vns.admin_change_source_host_approval(0,1,'grant','news.example.org',
      'Reviewed metadata and terms, synthetic only.',
      'ca220001-1111-4111-8111-111111111111',1);
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'stale auth version accepted'; END IF;
  refused:=false;
  BEGIN
    PERFORM vns.admin_change_source_host_approval(0,0,'grant','news.example.org',
      'Reviewed metadata and terms, synthetic only.',
      'ca220001-1111-4111-8111-111111111111',0);
  EXCEPTION WHEN invalid_parameter_value THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'zero source revision accepted'; END IF;
  refused:=false;
  BEGIN
    PERFORM vns.admin_change_source_host_approval(0,1,'grant','127.0.0.1',
      'Reviewed metadata and terms, synthetic only.',
      'ca220001-1111-4111-8111-111111111111',0);
  EXCEPTION WHEN invalid_parameter_value THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'IP host accepted'; END IF;
  refused:=false;
  BEGIN
    PERFORM vns.admin_change_source_host_approval(0,1,'grant','news.example.org',
      'short',
      'ca220001-1111-4111-8111-111111111111',0);
  EXCEPTION WHEN invalid_parameter_value THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'undocumented host grant accepted'; END IF;
END;
$deny$;
RESET ROLE;

-- Real source review via the separate source writer and 0021 SQL guard.
SET LOCAL ROLE vns_source_admin_writer;
DO $source$
DECLARE source jsonb := '{"id":"ci_host_source","baseUrl":"https://news.example.org/news/",
 "access":"rss","intervalMinutes":60,"termsUrl":"https://news.example.org/terms/",
 "usage":"metadata_only","licenseNotes":"Synthetic, operator review required.",
 "status":"pending","reviewedAt":"2026-10-26"}'::jsonb;
BEGIN
  IF vns.admin_commit_source_registry(0,1,jsonb_build_array(source),'ci_host_source',
    'create_pending','ca220001-1111-4111-8111-111111111111',0,
    '2026-10-26T12:00:00Z') IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'source create failed'; END IF;
  IF vns.admin_commit_source_registry(1,2,
    jsonb_build_array(jsonb_set(source,'{status}','"approved"'::jsonb)),
    'ci_host_source','approve','ca220001-1111-4111-8111-111111111111',0,
    '2026-10-26T12:00:00Z') IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'source approval failed'; END IF;
END;
$source$;
RESET ROLE;

SET LOCAL ROLE vns_host_approval_writer;
DO $mutate$
DECLARE result boolean; refused boolean;
BEGIN
  result:=vns.admin_change_source_host_approval(0,1,'grant','news.example.org',
      'Reviewed synthetic terms and limited metadata rights.',
      'ca220001-1111-4111-8111-111111111111',0);
  IF result IS DISTINCT FROM false THEN RAISE EXCEPTION 'stale source revision admitted'; END IF;
  refused:=false;
  BEGIN
    PERFORM vns.admin_change_source_host_approval(0,2,'grant','unknown.example.org',
      'Reviewed synthetic terms and limited metadata rights.',
      'ca220001-1111-4111-8111-111111111111',0);
  EXCEPTION WHEN invalid_parameter_value THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'unapproved-source host accepted'; END IF;

  result:=vns.admin_change_source_host_approval(0,2,'grant','news.example.org',
      'Reviewed synthetic terms and limited metadata rights.',
      'ca220001-1111-4111-8111-111111111111',0);
  IF result IS DISTINCT FROM true THEN RAISE EXCEPTION 'independent grant failed'; END IF;
  result:=vns.admin_change_source_host_approval(0,2,'grant','news.example.org',
      'Reviewed synthetic terms and limited metadata rights.',
      'ca220001-1111-4111-8111-111111111111',0);
  IF result IS DISTINCT FROM false THEN RAISE EXCEPTION 'stale CAS accepted'; END IF;
  refused:=false;
  BEGIN
    PERFORM vns.admin_change_source_host_approval(1,2,'grant','news.example.org',
      'Reviewed synthetic terms and limited metadata rights.',
      'ca220001-1111-4111-8111-111111111111',0);
  EXCEPTION WHEN invalid_parameter_value THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'duplicate grant accepted'; END IF;
  result:=vns.admin_change_source_host_approval(1,2,'revoke','news.example.org',
      'Host permission withdrawn for additional review.',
      'ca220001-1111-4111-8111-111111111111',0);
  IF result IS DISTINCT FROM true THEN RAISE EXCEPTION 'independent revoke failed'; END IF;
END;
$mutate$;
RESET ROLE;
DO $audit$
DECLARE denied boolean:=false;
BEGIN
  IF (SELECT revision FROM vns.admin_source_host_approvals WHERE singleton)<>2
    OR (SELECT approved_hosts FROM vns.admin_source_host_approvals WHERE singleton)<>'[]'::jsonb
    OR (SELECT count(*) FROM vns.admin_source_host_audit)<>2
    OR (SELECT count(*) FROM vns.admin_source_host_audit
      WHERE editor_username='ci_host_admin' AND editor_auth_version=0
        AND source_revision=2 AND database_login=session_user)<>2
  THEN RAISE EXCEPTION 'host audit or revision incorrect'; END IF;
  BEGIN UPDATE vns.admin_source_host_audit SET editor_username='fake';
  EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'host audit modified'; END IF;
END;
$audit$;
UPDATE vns.editor_accounts SET active=false WHERE id='ca220001-1111-4111-8111-111111111111';
SET LOCAL ROLE vns_host_approval_writer;
DO $revocation$
DECLARE denied boolean:=false;
BEGIN
  BEGIN PERFORM vns.admin_change_source_host_approval(2,2,'grant','news.example.org',
    'Reviewed synthetic terms and limited metadata rights.',
    'ca220001-1111-4111-8111-111111111111',1);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'deactivated host admin accepted'; END IF;
END;
$revocation$;
RESET ROLE;
ROLLBACK;
