-- 0062 synthetic real-PostgreSQL owner-gated host reconfirmation.
-- Must not mutate real approvals; executed only inside disposable CI rollback.
BEGIN;
INSERT INTO vns.editor_accounts(
  id,username,display_name,role,password_hash,active
) VALUES (
  'fa620001-1111-4111-8111-111111111111',
  'ci_renew_owner','Synthetic reviewer','admin',
  'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true
);
CREATE ROLE editor_ci_renew_owner LOGIN INHERIT;
CREATE ROLE editor_ci_renew_forged LOGIN INHERIT;
GRANT vns_p2_named_client TO editor_ci_renew_owner;
GRANT vns_host_approval_writer TO editor_ci_renew_forged;
INSERT INTO vns.editor_db_principals(login_role,editor_id,auth_version,active)
VALUES('editor_ci_renew_owner','fa620001-1111-4111-8111-111111111111',0,true);

UPDATE vns.single_owner_review_policy
   SET enabled=true,
       owner_editor_id='fa620001-1111-4111-8111-111111111111',
       operator_reason='Synthetic DBA enrollment of sole accountable host reviewer for CI only.',
       authorized_at=clock_timestamp()
 WHERE singleton=true;

SET SESSION AUTHORIZATION editor_ci_renew_owner;
DO $create$
DECLARE
  srev bigint; hrev bigint; items jsonb; article jsonb;
  refused boolean:=false;
BEGIN
  SELECT revision,sources INTO srev,items FROM vns.named_source_read();
  article:=jsonb_build_object(
    'id','ci_reconfirm_source',
    'baseUrl','https://reconfirm.example.org/news/',
    'feedUrl','https://reconfirm.example.org/old.xml',
    'access','rss','intervalMinutes',60,
    'termsUrl','https://reconfirm.example.org/terms/',
    'usage','metadata_only',
    'licenseNotes','Synthetic metadata-only rights for reconfirmation tests.',
    'status','pending',
    'reviewedAt','2026-11-04'
  );
  IF NOT vns.named_source_commit(srev,srev+1,
      items||jsonb_build_array(article),'ci_reconfirm_source','create_pending')
  THEN RAISE EXCEPTION 'Failed to create candidate'; END IF;
  article:=jsonb_set(article,'{status}','"approved"'::jsonb);
  IF NOT vns.named_source_commit(srev+1,srev+2,
      items||jsonb_build_array(article),'ci_reconfirm_source','approve')
  THEN RAISE EXCEPTION 'Failed to approve candidate'; END IF;
  SELECT revision INTO hrev FROM vns.named_host_read();
  IF NOT vns.named_host_change(
    hrev,srev+2,'grant','reconfirm.example.org',
    'Reviewed exact metadata rights and the official synthetic feed URL.'
  ) THEN RAISE EXCEPTION 'Initial host approval failed'; END IF;

  -- A current same-revision grant cannot be renewed, even with valid credentials.
  BEGIN
    PERFORM vns.named_host_change(
      hrev+1,srev+2,'renew','reconfirm.example.org',
      'Duplicate same-revision renewal is not an independently new review.'
    );
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'Duplicate current renewal accepted'; END IF;

  -- Editor changes exact URL. This invalidates the old host audit generation.
  article:=jsonb_set(article,'{feedUrl}','"https://reconfirm.example.org/new.xml"'::jsonb);
  article:=jsonb_set(article,'{status}','"pending"'::jsonb);
  IF NOT vns.named_source_commit(srev+2,srev+3,
      items||jsonb_build_array(article),'ci_reconfirm_source','replace_pending')
  THEN RAISE EXCEPTION 'Failed to reopen URL for review'; END IF;
  article:=jsonb_set(article,'{status}','"approved"'::jsonb);
  IF NOT vns.named_source_commit(srev+3,srev+4,
      items||jsonb_build_array(article),'ci_reconfirm_source','approve')
  THEN RAISE EXCEPTION 'Failed to reapprove URL'; END IF;
  PERFORM set_config('vns.renew_source_rev',(srev+4)::text,true);
  PERFORM set_config('vns.renew_host_rev',(hrev+1)::text,true);
  PERFORM set_config('vns.renew_source_item',article::text,true);
END $create$;
RESET SESSION AUTHORIZATION;

DO $stale$
DECLARE
  refused boolean:=false;
BEGIN
  BEGIN
    PERFORM vns.read_approved_source_export();
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'Exporter accepted stale grant'; END IF;
  IF vns.feed_runtime_source_authorized(current_setting('vns.renew_source_item')::jsonb) THEN
    RAISE EXCEPTION 'Feed runtime accepted stale grant'; END IF;
END $stale$;

-- An unenrolled PostgreSQL principal cannot impersonate the owner, even with
-- the legacy host writer role and a forged owner UUID.
SET SESSION AUTHORIZATION editor_ci_renew_forged;
DO $forged$
DECLARE refused boolean:=false;
BEGIN
  BEGIN
    PERFORM vns.admin_change_source_host_approval(
      current_setting('vns.renew_host_rev')::bigint,
      current_setting('vns.renew_source_rev')::bigint,
      'renew','reconfirm.example.org',
      'Forged renewal must not bypass the owner-only physical login.',
      'fa620001-1111-4111-8111-111111111111',0
    );
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'Forged renewal accepted'; END IF;
END $forged$;
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION editor_ci_renew_owner;
DO $renew$
DECLARE
  srev bigint:=current_setting('vns.renew_source_rev')::bigint;
  hrev bigint:=current_setting('vns.renew_host_rev')::bigint;
  hosts_before jsonb; hosts_after jsonb;
  refused boolean:=false;
BEGIN
  SELECT approved_hosts INTO hosts_before FROM vns.named_host_read();
  IF vns.named_host_change(
    hrev,srev-1,'renew','reconfirm.example.org',
    'Stale source revision cannot authorize a renewed host approval.'
  ) THEN RAISE EXCEPTION 'Wrong source revision accepted'; END IF;

  IF NOT vns.named_host_change(
    hrev,srev,'renew','reconfirm.example.org',
    'Personally rechecked metadata-only usage rights for the updated feed URL.'
  ) THEN RAISE EXCEPTION 'Authorized renewal not saved'; END IF;
  SELECT approved_hosts INTO hosts_after FROM vns.named_host_read();
  IF hosts_before IS DISTINCT FROM hosts_after THEN
    RAISE EXCEPTION 'Renewal mutated approved host set'; END IF;
  IF vns.named_host_change(
    hrev,srev,'renew','reconfirm.example.org',
    'Duplicate CAS attempt should be rejected without another audit row.'
  ) THEN RAISE EXCEPTION 'Renewal bypassed revision CAS'; END IF;
  refused:=false;
  BEGIN
    PERFORM vns.named_host_change(
      hrev+1,srev,'renew','reconfirm.example.org',
      'Already-renewed host cannot be reviewed twice for same source revision.'
    );
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'Repeated current revision renewal accepted'; END IF;
END $renew$;
RESET SESSION AUTHORIZATION;

-- Synthetic CI-only diagnostics, no real source URL or secrets.
SELECT 'ci0062_source=' || revision
  FROM vns.admin_source_registry WHERE singleton;
SELECT 'ci0062_hosts=' || revision || ':' || approved_hosts::text
  FROM vns.admin_source_host_approvals WHERE singleton;
SELECT 'ci0062_audit=' || revision || ':' || source_revision || ':' || action || ':' || host
  FROM vns.admin_source_host_audit ORDER BY revision;
DO $assert$
DECLARE
  record jsonb;
BEGIN
  record:=vns.read_approved_source_export();
  IF (record->'sourceSnapshot'->>'revision')::bigint <>
       current_setting('vns.renew_source_rev')::bigint
    OR (record->'hostApproval'->>'revision')::bigint <>
       current_setting('vns.renew_host_rev')::bigint+1
  THEN RAISE EXCEPTION 'Exporter failed after renewed host grant'; END IF;
  IF NOT vns.feed_runtime_source_authorized(current_setting('vns.renew_source_item')::jsonb)
  THEN RAISE EXCEPTION 'Feed guard failed after renewed grant'; END IF;
  IF (SELECT count(*) FROM vns.admin_source_host_audit
      WHERE host='reconfirm.example.org'
        AND action='grant'
        AND source_revision=current_setting('vns.renew_source_rev')::bigint
        AND approval_model='single_owner')<>1
  THEN RAISE EXCEPTION 'Renewal audit incorrect'; END IF;
END $assert$;
ROLLBACK;
