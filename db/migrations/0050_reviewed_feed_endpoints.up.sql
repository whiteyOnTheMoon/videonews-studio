-- P2-01 0050: exact optional feed URL separate from reviewed article baseUrl.
-- Legacy 9-field sources remain valid; nothing is automatically approved.
BEGIN;
CREATE OR REPLACE FUNCTION vns.admin_commit_source_registry(
 p_expected bigint, p_next bigint, p_sources jsonb, p_source_id text,
 p_action text, p_editor_id uuid, p_auth_version integer, p_recorded_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $guard$
DECLARE
  v_username text;
  v_revision bigint;
  v_previous jsonb;
  v_item jsonb;
  v_old_target jsonb;
  v_new_target jsonb;
  v_old_others jsonb;
  v_new_others jsonb;
  v_host text;
  v_url text;
  v_key text;
  v_review_date text;
  v_count integer;
BEGIN
  IF p_expected IS NULL OR p_expected < 0 OR p_expected >= 9007199254740991
    OR p_next IS DISTINCT FROM p_expected+1
    OR p_sources IS NULL OR jsonb_typeof(p_sources) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_sources) > 20
    OR p_source_id IS NULL OR p_source_id !~ '^[a-z][a-z0-9_-]{2,40}$'
    OR p_action IS NULL
    OR p_action NOT IN ('create_pending','replace_pending','approve','block','reopen')
    OR p_editor_id IS NULL OR p_auth_version IS NULL OR p_auth_version NOT BETWEEN 0 AND 2147483647
    OR p_recorded_at IS NULL OR NOT isfinite(p_recorded_at)
  THEN RAISE EXCEPTION 'invalid source mutation' USING ERRCODE='22023'; END IF;

  -- Revalidate on the database clock/active account lock, not browser-supplied claims.
  SELECT username INTO v_username FROM vns.editor_accounts
    WHERE id=p_editor_id AND role='admin' AND active=true
      AND auth_version=p_auth_version FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin identity unavailable' USING ERRCODE='42501'; END IF;

  -- Lock and compare *before* writing. Concurrent writers cannot commit the same revision.
  SELECT revision,sources INTO v_revision,v_previous FROM vns.admin_source_registry
    WHERE singleton=true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'source registry unavailable' USING ERRCODE='55000'; END IF;
  IF v_revision<>p_expected THEN RETURN false; END IF;

  -- Every new snapshot entry must be a complete, typed, unique, canonical
  -- source record. The API performs stricter URL canonicalization separately.
  v_count:=0;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_sources) LOOP
    v_count:=v_count+1;
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_item)) NOT IN (9,10)
       OR ((SELECT count(*) FROM jsonb_object_keys(v_item))=10 AND NOT (v_item ? 'feedUrl'))
       OR NOT (v_item ?& ARRAY['id','baseUrl','access','intervalMinutes','termsUrl',
                                'usage','licenseNotes','status','reviewedAt'])
       OR jsonb_typeof(v_item->'id') IS DISTINCT FROM 'string'
       OR (v_item->>'id') !~ '^[a-z][a-z0-9_-]{2,40}$'
       OR jsonb_typeof(v_item->'baseUrl') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_item->'termsUrl') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_item->'access') IS DISTINCT FROM 'string'
       OR (v_item->>'access') NOT IN ('rss','atom','official_api','html')
       OR jsonb_typeof(v_item->'intervalMinutes') IS DISTINCT FROM 'number'
       OR (v_item->>'intervalMinutes') !~ '^(0|[1-9][0-9]*)$'
       OR length(v_item->>'intervalMinutes') > 5
       OR jsonb_typeof(v_item->'usage') IS DISTINCT FROM 'string'
       OR (v_item->>'usage') NOT IN ('metadata_only','reviewed_excerpt')
       OR jsonb_typeof(v_item->'licenseNotes') IS DISTINCT FROM 'string'
       OR length(v_item->>'licenseNotes') NOT BETWEEN 12 AND 300
       OR btrim(v_item->>'licenseNotes') <> v_item->>'licenseNotes'
       OR (v_item->>'licenseNotes') ~ '[[:cntrl:]]'
       OR jsonb_typeof(v_item->'status') IS DISTINCT FROM 'string'
       OR (v_item->>'status') NOT IN ('pending','approved','blocked')
       OR jsonb_typeof(v_item->'reviewedAt') IS DISTINCT FROM 'string'
       OR (v_item->>'reviewedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    THEN RAISE EXCEPTION 'invalid source record' USING ERRCODE='22023'; END IF;
    IF (v_item->>'intervalMinutes')::integer NOT BETWEEN 15 AND 10080
    THEN RAISE EXCEPTION 'invalid source interval' USING ERRCODE='22023'; END IF;
    IF to_char((v_item->>'reviewedAt')::date,'YYYY-MM-DD') <> v_item->>'reviewedAt'
    THEN RAISE EXCEPTION 'invalid source review date' USING ERRCODE='22023'; END IF;
    FOREACH v_key IN ARRAY ARRAY['baseUrl','termsUrl'] LOOP
      v_url:=v_item->>v_key;
      IF length(v_url) NOT BETWEEN 18 AND 512
         OR v_url !~ '^https://[a-z0-9-]+([.][a-z0-9-]+)+(/[^?#%:@\\]*)?$'
         OR v_url ~ '[[:space:][:cntrl:]]'
         OR (v_key='baseUrl' AND right(v_url,1)<>'/')
      THEN RAISE EXCEPTION 'invalid source URL' USING ERRCODE='22023'; END IF;
      v_host:=split_part(split_part(v_url,'https://',2),'/',1);
      IF length(v_host)>253
        OR v_host ~ '^[0-9]+([.][0-9]+){3}$'
        OR v_host ~ '[.](local|internal|localhost)$'
        OR EXISTS(
          SELECT 1 FROM unnest(string_to_array(v_host,'.')) AS host_label
          WHERE length(host_label)>63 OR host_label !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
        )
      THEN RAISE EXCEPTION 'invalid source hostname' USING ERRCODE='22023'; END IF;
    END LOOP;
    -- Exact feedUrl may differ in path, never in host.
    IF v_item ? 'feedUrl' THEN
      v_url := v_item->>'feedUrl';
      IF jsonb_typeof(v_item->'feedUrl') IS DISTINCT FROM 'string'
        OR length(v_url) NOT BETWEEN 18 AND 512
        OR v_url !~ '^https://[a-z0-9-]+([.][a-z0-9-]+)+(/[^?#%:@\\]*)?$'
        OR v_url ~ '[[:space:][:cntrl:]]'
        OR v_url IS NOT DISTINCT FROM v_item->>'baseUrl'
        OR split_part(split_part(v_url,'https://',2),'/',1)
          IS DISTINCT FROM split_part(split_part(v_item->>'baseUrl','https://',2),'/',1)
      THEN RAISE EXCEPTION 'Feed endpoint scope invalid' USING ERRCODE='22023'; END IF;
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT entry->>'id') FROM jsonb_array_elements(p_sources) AS entry)<>v_count
    OR (SELECT count(DISTINCT entry->>'baseUrl') FROM jsonb_array_elements(p_sources) AS entry)<>v_count
    OR (SELECT count(DISTINCT coalesce(entry->>'feedUrl',entry->>'baseUrl'))
        FROM jsonb_array_elements(p_sources) AS entry)<>v_count
  THEN RAISE EXCEPTION 'duplicate source' USING ERRCODE='22023'; END IF;

  SELECT value INTO v_old_target FROM jsonb_array_elements(v_previous) AS value
    WHERE value->>'id'=p_source_id;
  SELECT value INTO v_new_target FROM jsonb_array_elements(p_sources) AS value
    WHERE value->>'id'=p_source_id;
  v_old_others:=COALESCE(
    (SELECT jsonb_agg(value ORDER BY value->>'id')
     FROM jsonb_array_elements(v_previous) AS value WHERE value->>'id'<>p_source_id),
    '[]'::jsonb);
  v_new_others:=COALESCE(
    (SELECT jsonb_agg(value ORDER BY value->>'id')
     FROM jsonb_array_elements(p_sources) AS value WHERE value->>'id'<>p_source_id),
    '[]'::jsonb);
  v_review_date:=to_char(p_recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD');

  IF v_new_target IS NULL OR v_old_others IS DISTINCT FROM v_new_others
    OR v_new_target->>'reviewedAt' IS DISTINCT FROM v_review_date
  THEN RAISE EXCEPTION 'source state transition denied' USING ERRCODE='22023'; END IF;
  IF p_action='create_pending' THEN
    IF v_old_target IS NOT NULL OR jsonb_array_length(p_sources)<>jsonb_array_length(v_previous)+1
       OR v_new_target->>'status'<>'pending'
    THEN RAISE EXCEPTION 'create transition denied' USING ERRCODE='22023'; END IF;
  ELSIF p_action='replace_pending' THEN
    IF v_old_target IS NULL OR jsonb_array_length(p_sources)<>jsonb_array_length(v_previous)
       OR v_new_target->>'status'<>'pending'
    THEN RAISE EXCEPTION 'replace transition denied' USING ERRCODE='22023'; END IF;
  ELSE
    IF v_old_target IS NULL OR jsonb_array_length(p_sources)<>jsonb_array_length(v_previous)
      OR (v_old_target - 'status' - 'reviewedAt') IS DISTINCT FROM
         (v_new_target - 'status' - 'reviewedAt')
    THEN RAISE EXCEPTION 'review metadata change denied' USING ERRCODE='22023'; END IF;
    IF (p_action='approve' AND
        (v_old_target->>'status'<>'pending' OR v_new_target->>'status'<>'approved'))
       OR (p_action='block' AND
        (v_old_target->>'status'='blocked' OR v_new_target->>'status'<>'blocked'))
       OR (p_action='reopen' AND
        (v_old_target->>'status'<>'blocked' OR v_new_target->>'status'<>'pending'))
    THEN RAISE EXCEPTION 'review status transition denied' USING ERRCODE='22023'; END IF;
  END IF;

  UPDATE vns.admin_source_registry SET revision=p_next,sources=p_sources
    WHERE singleton=true AND revision=p_expected;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO vns.admin_source_audit
    (revision,source_id,action,editor_id,editor_username,editor_auth_version,recorded_at)
    VALUES(p_next,p_source_id,p_action,p_editor_id,v_username,p_auth_version,p_recorded_at);
  RETURN true;
END;
$guard$;
CREATE OR REPLACE FUNCTION vns.feed_runtime_source_authorized(p_source jsonb)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog
AS $body$
DECLARE
  v_revision bigint;
  v_sources jsonb;
  v_hosts jsonb;
  v_host text;
  v_host_action text;
  v_grant_source_revision bigint;
BEGIN
  IF p_source IS NULL OR jsonb_typeof(p_source) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_source)) NOT IN (9,10)
    OR ((SELECT count(*) FROM jsonb_object_keys(p_source))=10 AND NOT (p_source ? 'feedUrl'))
    OR NOT (p_source ?& ARRAY['id','baseUrl','access','intervalMinutes',
                             'termsUrl','usage','licenseNotes','status','reviewedAt'])
    OR p_source->>'status' IS DISTINCT FROM 'approved'
  THEN RETURN false; END IF;

  IF p_source ? 'feedUrl' THEN
    IF jsonb_typeof(p_source->'feedUrl') IS DISTINCT FROM 'string'
      OR length(p_source->>'feedUrl') NOT BETWEEN 18 AND 512
      OR p_source->>'feedUrl' !~ '^https://[a-z0-9-]+([.][a-z0-9-]+)+(/[^?#%:@\\]*)?$'
      OR p_source->>'feedUrl' IS NOT DISTINCT FROM p_source->>'baseUrl'
      OR split_part(split_part(p_source->>'feedUrl','https://',2),'/',1)
        IS DISTINCT FROM split_part(split_part(p_source->>'baseUrl','https://',2),'/',1)
    THEN RETURN false; END IF;
  END IF;

  -- Both governance rows are locked for this SQL transaction. Caller cannot
  -- gain table access; a concurrent revoke cannot overtake this decision.
  SELECT revision,sources INTO v_revision,v_sources
    FROM vns.admin_source_registry WHERE singleton=true FOR SHARE;
  IF NOT FOUND OR v_revision < 1 THEN RETURN false; END IF;
  SELECT approved_hosts INTO v_hosts FROM vns.admin_source_host_approvals
    WHERE singleton=true FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_sources) AS entry
    WHERE entry.value = p_source AND entry.value->>'status' = 'approved'
  ) THEN RETURN false; END IF;

  v_host := split_part(split_part(p_source->>'baseUrl','https://',2),'/',1);
  IF v_host IS NULL OR length(v_host) NOT BETWEEN 4 AND 253
    OR NOT (v_hosts ? v_host)
  THEN RETURN false; END IF;

  -- Host approval must still apply to the EXACT source snapshot generation.
  -- Source changes after a grant intentionally stop polling until the distinct
  -- human host-grant path is exercised again.
  SELECT action,source_revision INTO v_host_action,v_grant_source_revision
    FROM vns.admin_source_host_audit
    WHERE host=v_host ORDER BY revision DESC LIMIT 1;
  RETURN v_host_action = 'grant' AND v_grant_source_revision = v_revision;
END;
$body$;
ALTER FUNCTION vns.admin_commit_source_registry(
 bigint,bigint,jsonb,text,text,uuid,integer,timestamptz
) OWNER TO vns_source_admin_executor;
ALTER FUNCTION vns.feed_runtime_source_authorized(jsonb)
 OWNER TO vns_feed_source_authority;
INSERT INTO vns.schema_migrations(version) VALUES ('0050_reviewed_feed_endpoints');
COMMIT;
