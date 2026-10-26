-- P2-01 security regression: source writer and host approver must be separate.
-- Exercise on disposable CI database only. No real sources or identities.
BEGIN;
DO $acl$
BEGIN
  IF has_function_privilege('vns_source_admin_writer',
       'vns.admin_change_source_host_approval(bigint,bigint,text,text,text,uuid,integer)','EXECUTE')
     OR has_function_privilege('vns_host_approval_writer',
       'vns.admin_commit_source_registry(bigint,bigint,jsonb,text,text,uuid,integer,timestamptz)','EXECUTE')
     OR has_table_privilege('vns_source_admin_writer','vns.admin_source_host_approvals','SELECT')
     OR has_table_privilege('vns_host_approval_writer','vns.admin_source_registry','SELECT')
     OR has_table_privilege('vns_api_runtime','vns.admin_source_host_approvals','SELECT')
     OR has_table_privilege('vns_api_runtime','vns.admin_source_registry','SELECT')
     OR has_role('vns_source_admin_writer','vns_host_approval_writer','MEMBER')
     OR has_role('vns_host_approval_writer','vns_source_admin_writer','MEMBER')
  THEN RAISE EXCEPTION 'source-host privilege boundary violated'; END IF;
END;
$acl$;

SET LOCAL ROLE vns_source_admin_writer;
DO $deny_host$
DECLARE refused boolean:=false;
BEGIN
  BEGIN
    PERFORM vns.admin_change_source_host_approval(0,1,'grant','news.example.org',
      'This is synthetic independent approval evidence only.',
      'ca220001-1111-4111-8111-111111111111',0);
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'source writer can grant hosts'; END IF;
END;
$deny_host$;
RESET ROLE;

SET LOCAL ROLE vns_host_approval_writer;
DO $deny_source$
DECLARE refused boolean:=false;
BEGIN
  BEGIN
    PERFORM vns.admin_commit_source_registry(0,1,'[]'::jsonb,
      'synthetic','create_pending','ca220001-1111-4111-8111-111111111111',0,now());
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'host approver can mutate sources'; END IF;
END;
$deny_source$;
RESET ROLE;
ROLLBACK;
