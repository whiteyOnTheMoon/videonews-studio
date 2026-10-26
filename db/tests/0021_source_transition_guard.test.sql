-- 0021: Assert a writer cannot forge transitions or bypass source schema.
-- All test identities and source data are synthetic; rolled back on completion.
BEGIN;
INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES ('ca210001-1111-4111-8111-111111111111','ci_transition_admin',
 'CI Transition Admin','admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);
SET LOCAL ROLE vns_source_admin_writer;
DO $checks$
DECLARE
  p jsonb := '{"id":"ci_source","baseUrl":"https://example.org/news/",
    "access":"rss","intervalMinutes":60,"termsUrl":"https://example.org/terms/",
    "usage":"metadata_only","licenseNotes":"Synthetic fixture metadata only.",
    "status":"pending","reviewedAt":"2026-10-26"}'::jsonb;
  previous jsonb;
  next_data jsonb;
  new_target jsonb;
  wrong jsonb;
  succeeded boolean;
  refused boolean;
  action_name text;
  id uuid := 'ca210001-1111-4111-8111-111111111111';
  observed_revision bigint:=0;
BEGIN
  -- A new source can only appear with status pending, even with valid admin.
  refused:=false;
  BEGIN
    PERFORM vns.admin_commit_source_registry(0,1,jsonb_build_array(
        jsonb_set(p,'{status}','"approved"'::jsonb)
      ),'ci_source','create_pending',id,0,'2026-10-26T12:00:00Z');
  EXCEPTION WHEN invalid_parameter_value THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'Unreviewed source accepted as approved'; END IF;

  FOREACH action_name IN ARRAY ARRAY['unknown_status','extra_field','wrong_id','bad_url',
                                      'bad_interval','bad_license','bad_date','duplicate'] LOOP
    refused:=false;
    wrong:=p;
    CASE action_name
      WHEN 'unknown_status' THEN wrong:=jsonb_set(p,'{status}','"active"'::jsonb);
      WHEN 'extra_field' THEN wrong:=p||'{"secret":"synthetic"}'::jsonb;
      WHEN 'wrong_id' THEN wrong:=jsonb_set(p,'{id}','"injected_source"'::jsonb);
      WHEN 'bad_url' THEN wrong:=jsonb_set(p,'{baseUrl}','"http://127.0.0.1/"'::jsonb);
      WHEN 'bad_interval' THEN wrong:=jsonb_set(p,'{intervalMinutes}','1'::jsonb);
      WHEN 'bad_license' THEN wrong:=jsonb_set(p,'{licenseNotes}','"tiny"'::jsonb);
      WHEN 'bad_date' THEN wrong:=jsonb_set(p,'{reviewedAt}','"2026-02-30"'::jsonb);
      WHEN 'duplicate' THEN wrong:=p;
    END CASE;
    BEGIN
      PERFORM vns.admin_commit_source_registry(0,1,
        CASE WHEN action_name='duplicate' THEN jsonb_build_array(p,p)
             ELSE jsonb_build_array(wrong) END,
        'ci_source','create_pending',id,0,'2026-10-26T12:00:00Z');
    EXCEPTION WHEN invalid_parameter_value OR datetime_field_overflow THEN refused:=true; END;
    IF NOT refused THEN RAISE EXCEPTION 'Invalid source data admitted: %',action_name; END IF;
  END LOOP;

  succeeded:=vns.admin_commit_source_registry(0,1,jsonb_build_array(p),'ci_source',
             'create_pending',id,0,'2026-10-26T12:00:00Z');
  IF succeeded IS DISTINCT FROM true THEN RAISE EXCEPTION 'Pending create failed'; END IF;
  observed_revision:=1;
  previous:=jsonb_build_array(p);

  -- A stale compare-and-swap remains a conflict, without another audit.
  succeeded:=vns.admin_commit_source_registry(0,1,previous,'ci_source',
             'create_pending',id,0,'2026-10-26T12:00:00Z');
  IF succeeded IS DISTINCT FROM false THEN RAISE EXCEPTION 'Stale CAS succeeded'; END IF;

  -- Cannot approve while altering license or URL under the cover of a review.
  next_data:=jsonb_build_array(jsonb_set(p,'{status}','"approved"'::jsonb));
  refused:=false;
  BEGIN
    PERFORM vns.admin_commit_source_registry(1,2,
      jsonb_build_array(jsonb_set(next_data->0,'{baseUrl}','"https://evil.example.org/"'::jsonb)),
      'ci_source','approve',id,0,'2026-10-26T12:00:00Z');
  EXCEPTION WHEN invalid_parameter_value THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'Approve smuggled source URL change'; END IF;

  succeeded:=vns.admin_commit_source_registry(1,2,next_data,'ci_source',
             'approve',id,0,'2026-10-26T12:00:00Z');
  IF succeeded IS DISTINCT FROM true THEN RAISE EXCEPTION 'Approve pending source failed'; END IF;
  observed_revision:=2;

  refused:=false;
  BEGIN
    PERFORM vns.admin_commit_source_registry(2,3,next_data,'ci_source',
             'approve',id,0,'2026-10-26T12:00:00Z');
  EXCEPTION WHEN invalid_parameter_value THEN refused:=true; END;
  IF NOT refused THEN RAISE EXCEPTION 'Double approval accepted'; END IF;

  -- A block must change ONLY the targeted status/review date.
  new_target:=jsonb_set(next_data->0,'{status}','"blocked"'::jsonb);
  succeeded:=vns.admin_commit_source_registry(2,3,jsonb_build_array(new_target),
             'ci_source','block',id,0,'2026-10-26T12:00:00Z');
  IF succeeded IS DISTINCT FROM true THEN RAISE EXCEPTION 'Block approved source failed'; END IF;
  observed_revision:=3;
  succeeded:=vns.admin_commit_source_registry(3,4,previous,'ci_source',
             'reopen',id,0,'2026-10-26T12:00:00Z');
  IF succeeded IS DISTINCT FROM true THEN RAISE EXCEPTION 'Reopen blocked source failed'; END IF;
  observed_revision:=4;

  -- Replacing metadata must force pending, not silently keep approval.
  succeeded:=vns.admin_commit_source_registry(4,5,
      jsonb_build_array(jsonb_set(p,'{licenseNotes}',
                               '"Synthetic reviewed metadata changed."'::jsonb)),
      'ci_source','replace_pending',id,0,'2026-10-26T12:00:00Z');
  IF succeeded IS DISTINCT FROM true THEN RAISE EXCEPTION 'Pending metadata update failed'; END IF;
  observed_revision:=5;

  SELECT revision INTO observed_revision FROM vns.admin_source_registry WHERE singleton=true;
  IF observed_revision<>5 THEN
    RAISE EXCEPTION 'Source revision mismatch, got %',observed_revision;
  END IF;
END;
$checks$;
RESET ROLE;
DO $audit$
BEGIN
  IF (SELECT count(*) FROM vns.admin_source_audit)<>5
     OR (SELECT revision FROM vns.admin_source_registry WHERE singleton=true)<>5
     OR EXISTS(SELECT 1 FROM vns.admin_source_audit
               WHERE editor_username<>'ci_transition_admin' OR editor_auth_version<>0)
  THEN RAISE EXCEPTION 'Revision/audit attribution mismatch'; END IF;
END;
$audit$;
ROLLBACK;
