-- 0061 single-owner review is explicit, audited, and restricted to physical LOGIN.
-- Disposable PostgreSQL only; all synthetic records roll back.
BEGIN;

INSERT INTO vns.editor_accounts(
  id,username,display_name,role,password_hash,active
) VALUES (
  'fa610001-1111-4111-8111-111111111111',
  'ci_solo_owner','Synthetic project owner','admin',
  'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true
);

CREATE ROLE editor_ci_solo_owner LOGIN INHERIT;
CREATE ROLE editor_ci_solo_forged LOGIN INHERIT;
GRANT vns_p2_named_client TO editor_ci_solo_owner;
-- Assert legacy host-writer privilege cannot impersonate enrolled owner.
GRANT vns_host_approval_writer TO editor_ci_solo_forged;
INSERT INTO vns.editor_db_principals(
  login_role,editor_id,auth_version,active
) VALUES (
  'editor_ci_solo_owner',
  'fa610001-1111-4111-8111-111111111111',0,true
);

DO $deny$
BEGIN
  IF (SELECT enabled FROM vns.single_owner_review_policy WHERE singleton=true) OR
     has_table_privilege('vns_p2_named_client',
       'vns.single_owner_review_policy','UPDATE') OR
     has_table_privilege('vns_host_approval_writer',
       'vns.single_owner_review_policy','UPDATE')
  THEN RAISE EXCEPTION 'Owner mode not default OFF'; END IF;
END $deny$;

SET SESSION AUTHORIZATION editor_ci_solo_owner;
DO $source$
DECLARE
  current_revision bigint;
  host_revision bigint;
  current_sources jsonb;
  item jsonb;
  refused boolean:=false;
BEGIN
  SELECT s.revision,s.sources
    INTO current_revision,current_sources FROM vns.named_source_read() s;
  item:=jsonb_build_object(
    'id','ci_solo_feed',
    'baseUrl','https://solo.example.org/news/',
    'feedUrl','https://solo.example.org/rss.xml',
    'access','rss','intervalMinutes',60,
    'termsUrl','https://solo.example.org/terms/',
    'usage','metadata_only',
    'licenseNotes','CI-only synthetic data; no real news rights.',
    'status','pending',
    'reviewedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD')
  );
  IF NOT vns.named_source_commit(
    current_revision,current_revision+1,
    current_sources||jsonb_build_array(item),'ci_solo_feed','create_pending'
  ) THEN RAISE EXCEPTION 'Pending creation failed'; END IF;
  item:=jsonb_set(item,'{status}','"approved"'::jsonb);
  IF NOT vns.named_source_commit(
    current_revision+1,current_revision+2,
    current_sources||jsonb_build_array(item),'ci_solo_feed','approve'
  ) THEN RAISE EXCEPTION 'Same owner source approval failed'; END IF;
  PERFORM set_config('vns.ci_solo_source_revision',
    (current_revision+2)::text,true);
  SELECT h.revision INTO host_revision FROM vns.named_host_read() h;
  PERFORM set_config('vns.ci_solo_host_revision',host_revision::text,true);
  -- The policy defaults OFF, even the personal owner cannot self-grant.
  BEGIN
    PERFORM vns.named_host_change(
      host_revision,current_revision+2,'grant','solo.example.org',
      'CI-only source reviewed by sole owner; host grant not enabled yet.');
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'Solo grant bypassed default-OFF policy'; END IF;
  refused:=false;
  BEGIN
    UPDATE vns.single_owner_review_policy
       SET enabled=true WHERE singleton=true;
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'Named client changed DBA policy'; END IF;
END $source$;
RESET SESSION AUTHORIZATION;

-- Model explicit operator/DBA approval of a single owner.
UPDATE vns.single_owner_review_policy
 SET enabled=true,
     owner_editor_id='fa610001-1111-4111-8111-111111111111',
     operator_reason='The project is operated and reviewed by one accountable human owner.',
     authorized_at=clock_timestamp()
 WHERE singleton=true;

-- Legacy writer must NOT spoof the sole owner's UUID, even with writer grants.
SET SESSION AUTHORIZATION editor_ci_solo_forged;
DO $forged$
DECLARE refused boolean:=false;
BEGIN
  BEGIN
    PERFORM vns.admin_change_source_host_approval(
      current_setting('vns.ci_solo_host_revision')::bigint,
      current_setting('vns.ci_solo_source_revision')::bigint,
      'grant','solo.example.org',
      'Forger claims source owner identity but holds a separate login.',
      'fa610001-1111-4111-8111-111111111111',0);
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'Shared writer impersonated sole owner'; END IF;
END $forged$;
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION editor_ci_solo_owner;
DO $grant$
DECLARE
  rev bigint:=current_setting('vns.ci_solo_host_revision')::bigint;
  source_rev bigint:=current_setting('vns.ci_solo_source_revision')::bigint;
  approved jsonb;
BEGIN
  IF NOT vns.named_host_change(
    rev,source_rev,'grant','solo.example.org',
    'Solo project owner separately reviewed host scope and metadata usage terms.'
  ) THEN RAISE EXCEPTION 'Owner-mode host grant refused'; END IF;
  SELECT h.approved_hosts INTO approved FROM vns.named_host_read() h;
  IF NOT (approved ? 'solo.example.org') THEN
    RAISE EXCEPTION 'Host grant not readable';
  END IF;
  IF vns.named_host_change(
    rev,source_rev,'grant','solo.example.org',
    'Stale owner host grant must fail against changed revision.'
  ) THEN RAISE EXCEPTION 'Host grant CAS bypassed'; END IF;
END $grant$;
RESET SESSION AUTHORIZATION;

DO $audit$
BEGIN
  IF (
    SELECT count(*) FROM vns.admin_source_host_audit
    WHERE host='solo.example.org'
      AND editor_id='fa610001-1111-4111-8111-111111111111'
      AND approval_model='single_owner'
  ) <> 1
  OR (
    SELECT count(*) FROM vns.admin_source_audit
    WHERE source_id='ci_solo_feed'
      AND editor_id='fa610001-1111-4111-8111-111111111111'
  ) <> 2
  THEN RAISE EXCEPTION 'Single-owner review audit not correctly attributed'; END IF;
END $audit$;

UPDATE vns.editor_db_principals
  SET active=false WHERE login_role='editor_ci_solo_owner';
SET SESSION AUTHORIZATION editor_ci_solo_owner;
DO $revoke$
DECLARE refused boolean:=false;
BEGIN
  BEGIN PERFORM * FROM vns.named_host_read();
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  IF NOT refused THEN
    RAISE EXCEPTION 'Revoked owner retained named host access';
  END IF;
END $revoke$;
RESET SESSION AUTHORIZATION;

ROLLBACK;
