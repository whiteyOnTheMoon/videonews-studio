-- P2-01: disposable PostgreSQL permission, CAS, audit and revocation tests.
-- Entire fixture is rolled back. No production credentials or sources.
BEGIN;
DO $acl$
BEGIN
  IF (SELECT count(*) FROM vns.schema_migrations WHERE version='0020_source_admin_registry')<>1
    OR (SELECT revision FROM vns.admin_source_registry WHERE singleton)<>0
    OR (SELECT count(*) FROM vns.admin_source_audit)<>0
    OR NOT has_function_privilege('vns_source_admin_writer',
       'vns.admin_commit_source_registry(bigint,bigint,jsonb,text,text,uuid,integer,timestamptz)','EXECUTE')
    OR has_function_privilege('vns_api_runtime',
       'vns.admin_commit_source_registry(bigint,bigint,jsonb,text,text,uuid,integer,timestamptz)','EXECUTE')
    OR has_function_privilege('vns_research_writer',
       'vns.admin_commit_source_registry(bigint,bigint,jsonb,text,text,uuid,integer,timestamptz)','EXECUTE')
    OR has_table_privilege('vns_source_admin_writer','vns.admin_source_registry','UPDATE')
    OR has_table_privilege('vns_source_admin_writer','vns.admin_source_audit','INSERT')
    OR has_table_privilege('vns_source_admin_writer','vns.editor_accounts','SELECT')
    OR NOT has_table_privilege('vns_source_admin_writer','vns.admin_source_registry','SELECT')
    OR (SELECT rolcanlogin FROM pg_roles WHERE rolname='vns_source_admin_writer')
    OR (SELECT rolcanlogin FROM pg_roles WHERE rolname='vns_source_admin_executor')
    OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=
       'vns.admin_commit_source_registry(bigint,bigint,jsonb,text,text,uuid,integer,timestamptz)'::regprocedure)
       <>'vns_source_admin_executor'
    OR NOT (SELECT prosecdef FROM pg_proc WHERE oid=
       'vns.admin_commit_source_registry(bigint,bigint,jsonb,text,text,uuid,integer,timestamptz)'::regprocedure)
  THEN RAISE EXCEPTION 'Source admin permission boundary invalid'; END IF;
END;
$acl$;

INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES
 ('ca110001-1111-4111-8111-111111111111','ci_source_admin',
  'CI Source Administrator','admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
 ('ca110002-2222-4222-8222-222222222222','ci_source_editor',
  'CI Source Editor','editor','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);

SET LOCAL ROLE vns_source_admin_writer;
DO $writer$
DECLARE
  v_denied boolean;
  v_saved boolean;
  v_payload jsonb := '[{"id":"ci_source","baseUrl":"https://example.org/news/",
    "access":"rss","intervalMinutes":60,"termsUrl":"https://example.org/terms/",
    "usage":"metadata_only","licenseNotes":"Synthetic fixture metadata only.",
    "status":"pending","reviewedAt":"2026-10-26"}]'::jsonb;
BEGIN
  v_denied:=false;
  BEGIN
    UPDATE vns.admin_source_registry SET revision=100 WHERE singleton;
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Writer can directly forge revision'; END IF;
  v_denied:=false;
  BEGIN
    INSERT INTO vns.admin_source_audit(revision,source_id,action,editor_id,editor_username,
      editor_auth_version,recorded_at)
    VALUES(100,'ci_source','approve','ca110001-1111-4111-8111-111111111111','forged',0,now());
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Writer can forge audit attribution'; END IF;

  v_denied:=false;
  BEGIN
    PERFORM vns.admin_commit_source_registry(0,1,v_payload,'ci_source','create_pending',
      'ca110002-2222-4222-8222-222222222222',0,now());
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Non-admin accepted'; END IF;

  v_denied:=false;
  BEGIN
    PERFORM vns.admin_commit_source_registry(0,1,v_payload,'ci_source','create_pending',
      'ca110001-1111-4111-8111-111111111111',1,now());
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Stale auth version accepted'; END IF;

  v_denied:=false;
  BEGIN
    PERFORM vns.admin_commit_source_registry(0,5,v_payload,'ci_source','create_pending',
      'ca110001-1111-4111-8111-111111111111',0,now());
  EXCEPTION WHEN invalid_parameter_value THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Skipped revision accepted'; END IF;

  v_saved:=vns.admin_commit_source_registry(0,1,v_payload,'ci_source','create_pending',
      'ca110001-1111-4111-8111-111111111111',0,'2026-10-26T12:00:00Z');
  IF v_saved IS DISTINCT FROM true THEN RAISE EXCEPTION 'Initial save failed'; END IF;
  v_saved:=vns.admin_commit_source_registry(0,1,v_payload,'ci_source','create_pending',
      'ca110001-1111-4111-8111-111111111111',0,'2026-10-26T12:00:00Z');
  IF v_saved IS DISTINCT FROM false THEN RAISE EXCEPTION 'Stale writer not rejected'; END IF;
END;
$writer$;
RESET ROLE;

DO $verify$
DECLARE v_denied boolean;
BEGIN
  IF (SELECT revision FROM vns.admin_source_registry WHERE singleton)<>1
    OR (SELECT count(*) FROM vns.admin_source_audit)<>1
    OR (SELECT sources->0->>'status' FROM vns.admin_source_registry WHERE singleton)<>'pending'
    OR NOT EXISTS (SELECT 1 FROM vns.admin_source_audit
      WHERE revision=1 AND action='create_pending' AND source_id='ci_source'
        AND editor_id='ca110001-1111-4111-8111-111111111111'
        AND editor_username='ci_source_admin' AND editor_auth_version=0
        AND database_login=session_user)
  THEN RAISE EXCEPTION 'Atomic source revision and named audit mismatch'; END IF;

  v_denied:=false;
  BEGIN UPDATE vns.admin_source_audit SET editor_username='altered';
  EXCEPTION WHEN invalid_parameter_value THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Audit UPDATE was allowed'; END IF;
  v_denied:=false;
  BEGIN DELETE FROM vns.admin_source_audit;
  EXCEPTION WHEN invalid_parameter_value THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Audit DELETE was allowed'; END IF;
  v_denied:=false;
  BEGIN TRUNCATE vns.admin_source_audit;
  EXCEPTION WHEN invalid_parameter_value THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Audit TRUNCATE was allowed'; END IF;
END;
$verify$;

UPDATE vns.editor_accounts SET active=false WHERE id='ca110001-1111-4111-8111-111111111111';
SET LOCAL ROLE vns_source_admin_writer;
DO $revoked$
DECLARE v_denied boolean:=false;
BEGIN
  BEGIN
    PERFORM vns.admin_commit_source_registry(1,2,'[]'::jsonb,'ci_source','block',
      'ca110001-1111-4111-8111-111111111111',1,now());
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Revoked admin accepted'; END IF;
END;
$revoked$;
RESET ROLE;
DO $final$
BEGIN
  IF (SELECT revision FROM vns.admin_source_registry WHERE singleton)<>1
    OR (SELECT count(*) FROM vns.admin_source_audit)<>1 THEN
    RAISE EXCEPTION 'Failed source mutation changed durable state';
  END IF;
END;
$final$;
ROLLBACK;
