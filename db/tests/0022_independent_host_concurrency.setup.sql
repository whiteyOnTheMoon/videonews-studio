-- CI-only fixture for independent concurrent grant attempts.
INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES('ca220003-3333-4333-8333-333333333333','ci_host_racer','CI Host Race Admin',
'admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);
SET ROLE vns_source_admin_writer;
DO $data$
DECLARE
  v_revision bigint;
  v_previous jsonb;
  source jsonb := '{"id":"ci_host_race","baseUrl":"https://race.example.org/feed/",
"access":"rss","intervalMinutes":60,"termsUrl":"https://race.example.org/terms/",
"usage":"metadata_only","licenseNotes":"Synthetic audit-only fixture source.",
"status":"pending","reviewedAt":"2026-10-26"}'::jsonb;
BEGIN
  SELECT revision,sources INTO v_revision,v_previous
    FROM vns.admin_source_registry WHERE singleton=true;
  IF v_revision<>1 THEN RAISE EXCEPTION 'unexpected preceding CI source revision'; END IF;
  IF vns.admin_commit_source_registry(v_revision,v_revision+1,
    v_previous || jsonb_build_array(source),'ci_host_race',
    'create_pending','ca220003-3333-4333-8333-333333333333',0,
    '2026-10-26T12:00:00Z') IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'racing source seed failed'; END IF;
  IF vns.admin_commit_source_registry(v_revision+1,v_revision+2,
    v_previous || jsonb_build_array(jsonb_set(source,'{status}','"approved"'::jsonb)),
    'ci_host_race','approve','ca220003-3333-4333-8333-333333333333',0,
    '2026-10-26T12:00:00Z') IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'racing source approval failed'; END IF;
END;
$data$;
RESET ROLE;
