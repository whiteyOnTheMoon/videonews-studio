-- P2-01 0060: real LOGIN-binding, atomic source review and two-human host gate.
-- Synthetic users, URLs and sources; transaction rolled back entirely.
BEGIN;

INSERT INTO vns.editor_accounts(
  id,username,display_name,role,password_hash,active
) VALUES (
  'fa600001-1111-4111-8111-111111111111','ci_gateway_source',
  'Synthetic source approver','admin',
  'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true
), (
  'fa600002-2222-4222-8222-222222222222','ci_gateway_host',
  'Synthetic distinct host reviewer','admin',
  'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true
);

CREATE ROLE editor_ci_gateway_source LOGIN INHERIT;
CREATE ROLE editor_ci_gateway_host LOGIN INHERIT;
CREATE ROLE editor_ci_gateway_unknown LOGIN INHERIT;
GRANT vns_p2_named_client TO
  editor_ci_gateway_source,editor_ci_gateway_host,editor_ci_gateway_unknown;
INSERT INTO vns.editor_db_principals(
  login_role,editor_id,auth_version,active
) VALUES (
  'editor_ci_gateway_source','fa600001-1111-4111-8111-111111111111',0,true
), (
  'editor_ci_gateway_host','fa600002-2222-4222-8222-222222222222',0,true
);

DO $scope$
BEGIN
  IF NOT has_function_privilege(
       'vns_p2_named_client','vns.named_source_read()','EXECUTE')
    OR NOT has_function_privilege(
       'vns_p2_named_client','vns.named_host_change(bigint,bigint,text,text,text)','EXECUTE')
    OR has_table_privilege('vns_p2_named_client','vns.admin_source_registry','SELECT')
    OR has_table_privilege('vns_p2_named_client','vns.admin_source_registry','UPDATE')
    OR has_table_privilege('vns_p2_named_client','vns.admin_source_host_approvals','SELECT')
    OR has_function_privilege(
       'vns_p2_named_client',
       'vns.admin_commit_source_registry(bigint,bigint,jsonb,text,text,uuid,integer,timestamptz)',
       'EXECUTE')
    OR has_function_privilege(
       'vns_p2_named_client',
       'vns.admin_change_source_host_approval(bigint,bigint,text,text,text,uuid,integer)',
       'EXECUTE')
    OR has_function_privilege('vns_api_runtime','vns.named_source_commit(bigint,bigint,jsonb,text,text)','EXECUTE')
  THEN RAISE EXCEPTION 'Source admin DB privileges unexpectedly broadened'; END IF;
END $scope$;

SET SESSION AUTHORIZATION editor_ci_gateway_source;
DO $source$
DECLARE
  source_record jsonb;
  current_sources jsonb;
  current_revision bigint;
  actor uuid;
  auth_version integer;
  denied boolean:=false;
BEGIN
  SELECT a.actor_id,a.actor_version INTO actor,auth_version
    FROM vns.named_source_actor() a;
  IF actor <> 'fa600001-1111-4111-8111-111111111111'::uuid
     OR auth_version <> 0 THEN
    RAISE EXCEPTION 'Named source identity mismatch';
  END IF;
  SELECT r.revision,r.sources INTO current_revision,current_sources
  FROM vns.named_source_read() r;
  IF current_revision IS NULL OR current_sources IS NULL THEN
    RAISE EXCEPTION 'Named source snapshot unavailable';
  END IF;
  -- Prior migration CI exercises may have persisted synthetic fixtures.
  -- Never assume registry revision 0 or an empty source list.
  PERFORM set_config('vns.ci_gateway_base_source_revision',
    current_revision::text,true);

  source_record:=jsonb_build_object(
    'id','ci_gateway_feed',
    'baseUrl','https://source.example.org/news/',
    'feedUrl','https://source.example.org/rss.xml',
    'access','rss','intervalMinutes',60,
    'termsUrl','https://source.example.org/terms/',
    'usage','metadata_only',
    'licenseNotes','Synthetic metadata-only source; no real rights approval.',
    'status','pending',
    'reviewedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD')
  );
  IF NOT vns.named_source_commit(
    current_revision,current_revision+1,
    current_sources||jsonb_build_array(source_record),
    'ci_gateway_feed','create_pending')
  THEN RAISE EXCEPTION 'Personal pending source creation refused'; END IF;

  IF vns.named_source_commit(
    current_revision,current_revision+1,
    current_sources||jsonb_build_array(source_record),
    'ci_gateway_feed','create_pending')
  THEN RAISE EXCEPTION 'Stale source write succeeded'; END IF;

  source_record:=jsonb_set(source_record,'{status}','"approved"'::jsonb);
  IF NOT vns.named_source_commit(
    current_revision+1,current_revision+2,
    current_sources||jsonb_build_array(source_record),
    'ci_gateway_feed','approve')
  THEN RAISE EXCEPTION 'Named source approval refused'; END IF;
  SELECT r.revision INTO current_revision FROM vns.named_source_read() r;
  IF current_revision<>(
    current_setting('vns.ci_gateway_base_source_revision')::bigint + 2
  ) THEN RAISE EXCEPTION 'Named source snapshot not updated'; END IF;
  PERFORM set_config('vns.ci_gateway_final_source_revision',
    current_revision::text,true);

  -- A sole reviewer cannot approve the host of their own source.
  BEGIN
    PERFORM vns.named_host_change(
      (SELECT h.revision FROM vns.named_host_read() h),
      current_revision,'grant','source.example.org',
      'Synthetic review reason from same human must be rejected.');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN
    RAISE EXCEPTION 'One human approved both source and host';
  END IF;

  denied:=false;
  BEGIN
    UPDATE vns.admin_source_registry SET revision=99 WHERE singleton=true;
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Named client obtained table UPDATE'; END IF;
END $source$;
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION editor_ci_gateway_host;
DO $host$
DECLARE
  current_revision bigint;
  approved jsonb;
BEGIN
  SELECT h.revision INTO current_revision FROM vns.named_host_read() h;
  PERFORM set_config('vns.ci_gateway_base_host_revision',
    current_revision::text,true);
  IF NOT vns.named_host_change(
    current_revision,
    current_setting('vns.ci_gateway_final_source_revision')::bigint,
    'grant','source.example.org',
    'Independent synthetic human approved the host separately.')
  THEN RAISE EXCEPTION 'Independent host grant failed'; END IF;
  SELECT h.revision,h.approved_hosts
    INTO current_revision,approved FROM vns.named_host_read() h;
  IF current_revision<>(
    current_setting('vns.ci_gateway_base_host_revision')::bigint + 1
  ) OR NOT (approved ? 'source.example.org') THEN
    RAISE EXCEPTION 'Personally reviewed host record missing';
  END IF;
  IF vns.named_host_change(
    current_revision-1,
    current_setting('vns.ci_gateway_final_source_revision')::bigint,
    'grant','source.example.org',
    'Stale independent host grant must fail closed.')
  THEN RAISE EXCEPTION 'Stale host CAS succeeded'; END IF;
END $host$;
RESET SESSION AUTHORIZATION;

DO $audit$
BEGIN
  IF (SELECT count(*) FROM vns.admin_source_audit
      WHERE editor_id='fa600001-1111-4111-8111-111111111111') <> 2
  OR (SELECT count(*) FROM vns.admin_source_host_audit
      WHERE editor_id='fa600002-2222-4222-8222-222222222222') <> 1
  THEN RAISE EXCEPTION 'Source/host attribution not durable'; END IF;
END $audit$;

SET SESSION AUTHORIZATION editor_ci_gateway_unknown;
DO $unknown$
DECLARE denied boolean:=false;
BEGIN
  BEGIN PERFORM * FROM vns.named_source_read();
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Unenrolled LOGIN read source data'; END IF;
  denied:=false;
  BEGIN PERFORM vns.named_host_change(
    1,2,'revoke','source.example.org','Unenrolled principal cannot revoke host.');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Unenrolled LOGIN changed host'; END IF;
END $unknown$;
RESET SESSION AUTHORIZATION;

UPDATE vns.editor_db_principals SET active=false
 WHERE login_role='editor_ci_gateway_source';
SET SESSION AUTHORIZATION editor_ci_gateway_source;
DO $revoked$
DECLARE denied boolean:=false;
BEGIN
  BEGIN PERFORM * FROM vns.named_source_read();
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Revoked source administrator retained access'; END IF;
END $revoked$;
RESET SESSION AUTHORIZATION;

ROLLBACK;
