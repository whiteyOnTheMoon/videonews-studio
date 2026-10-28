-- P1-09/#230: personally reviewed offline price/FX snapshots; NO activation.
-- SQL-only: no HTTP routes, provider requests, seeded rates, or spending permission.
BEGIN;

CREATE TABLE vns.provider_live_named_price_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK(kind IN ('model_price','fx_ceiling')),
  snapshot_id uuid NOT NULL,
  editor_id uuid NOT NULL REFERENCES vns.editor_accounts(id) ON DELETE RESTRICT,
  editor_username text NOT NULL CHECK(length(editor_username) BETWEEN 3 AND 32),
  editor_auth_version integer NOT NULL CHECK(editor_auth_version >= 0),
  database_login name NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(kind,snapshot_id)
);
CREATE INDEX live_named_price_review_editor_idx
 ON vns.provider_live_named_price_reviews(editor_id,reviewed_at DESC);
CREATE TRIGGER reject_live_named_price_review_change
 BEFORE UPDATE OR DELETE ON vns.provider_live_named_price_reviews
 FOR EACH ROW EXECUTE FUNCTION vns.reject_provider_usage_change();
CREATE TRIGGER reject_live_named_price_review_truncate
 BEFORE TRUNCATE ON vns.provider_live_named_price_reviews
 FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_provider_usage_change();

-- The same NOLOGIN executor as the existing personally audited provider
-- administration. The runtime config writer receives FUNCTION grants only.
GRANT SELECT, INSERT ON vns.provider_live_price_snapshots,
 vns.provider_live_fx_snapshots TO vns_provider_config_executor;
GRANT INSERT ON vns.provider_live_named_price_reviews
 TO vns_provider_config_executor;
GRANT SELECT ON vns.provider_live_named_price_reviews TO vns_audit_reader;

-- The same actor check is used by both functions. Lock the active admin row
-- to prevent password, role and auth-version revocations racing this write.
CREATE FUNCTION vns.admin_assert_live_price_reviewer(
 p_editor_id uuid,p_auth_version integer
) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $actor$
DECLARE v_username text;
BEGIN
 IF p_editor_id IS NULL OR p_auth_version IS NULL OR p_auth_version < 0 THEN
  RAISE EXCEPTION 'Named price reviewer unavailable' USING ERRCODE='42501';
 END IF;
 SELECT username INTO v_username FROM vns.editor_accounts
  WHERE id=p_editor_id AND role='admin' AND active=true
   AND auth_version=p_auth_version FOR SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Named price reviewer unavailable' USING ERRCODE='42501';
 END IF;
 RETURN v_username;
END $actor$;

CREATE FUNCTION vns.admin_review_live_provider_price_as_editor(
 p_editor_id uuid,p_auth_version integer,p_provider text,p_model text,
 p_price_version text,p_input_rate bigint,p_cache_rate bigint,
 p_output_rate bigint,p_expires_at timestamptz,p_source_reference text
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $price$
DECLARE v_name text; v_id uuid; v_now timestamptz := clock_timestamp();
BEGIN
 -- Never let a browser or vendor response set reviewed_by.
 v_name:=vns.admin_assert_live_price_reviewer(p_editor_id,p_auth_version);
 IF p_provider IS NULL OR p_provider NOT IN ('openai','google_gemini')
  OR p_model IS NULL OR p_model !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
  OR p_price_version IS NULL OR p_price_version !~ '^[A-Za-z0-9_-]{12,80}$'
  OR p_input_rate IS NULL OR p_input_rate NOT BETWEEN 0 AND 1000000000000
  OR p_cache_rate IS NULL OR p_cache_rate NOT BETWEEN 0 AND 1000000000000
  OR p_output_rate IS NULL OR p_output_rate NOT BETWEEN 0 AND 1000000000000
  OR p_cache_rate > p_input_rate OR p_input_rate+p_output_rate=0
  OR p_expires_at IS NULL OR p_expires_at <= v_now+interval '5 minutes'
  OR p_expires_at > v_now+interval '7 days'
  OR p_source_reference IS NULL
  OR length(p_source_reference) NOT BETWEEN 12 AND 512
  OR p_source_reference !~ '^https://[^[:space:]@/?#]+/[^[:space:]]+$'
 THEN RAISE EXCEPTION 'Reviewed price invalid' USING ERRCODE='22023'; END IF;
 INSERT INTO vns.provider_live_price_snapshots
   (provider,model,price_version,input_micro_usd_per_million,
    cached_micro_usd_per_million,output_micro_usd_per_million,
    expires_at,source_reference,reviewed_by,reviewed_at)
 VALUES(p_provider,p_model,p_price_version,p_input_rate,p_cache_rate,
   p_output_rate,p_expires_at,p_source_reference,v_name,v_now)
 RETURNING id INTO v_id;
 INSERT INTO vns.provider_live_named_price_reviews
  (kind,snapshot_id,editor_id,editor_username,editor_auth_version,database_login)
 VALUES('model_price',v_id,p_editor_id,v_name,p_auth_version,session_user);
 RETURN v_id;
END $price$;

CREATE FUNCTION vns.admin_review_live_provider_fx_as_editor(
 p_editor_id uuid,p_auth_version integer,p_rate_nanos bigint,
 p_expires_at timestamptz,p_source_reference text
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $fx$
DECLARE v_name text; v_id uuid; v_now timestamptz := clock_timestamp();
BEGIN
 v_name:=vns.admin_assert_live_price_reviewer(p_editor_id,p_auth_version);
 IF p_rate_nanos IS NULL OR p_rate_nanos NOT BETWEEN 1 AND 10000000000
  OR p_expires_at IS NULL OR p_expires_at <= v_now+interval '5 minutes'
  OR p_expires_at > v_now+interval '24 hours'
  OR p_source_reference IS NULL
  OR length(p_source_reference) NOT BETWEEN 12 AND 512
  OR p_source_reference !~ '^https://[^[:space:]@/?#]+/[^[:space:]]+$'
 THEN RAISE EXCEPTION 'Reviewed FX invalid' USING ERRCODE='22023'; END IF;
 INSERT INTO vns.provider_live_fx_snapshots
  (micro_eur_per_micro_usd_nanos,expires_at,source_reference,reviewed_by,reviewed_at)
 VALUES(p_rate_nanos,p_expires_at,p_source_reference,v_name,v_now)
 RETURNING id INTO v_id;
 INSERT INTO vns.provider_live_named_price_reviews
  (kind,snapshot_id,editor_id,editor_username,editor_auth_version,database_login)
 VALUES('fx_ceiling',v_id,p_editor_id,v_name,p_auth_version,session_user);
 RETURN v_id;
END $fx$;

REVOKE ALL ON FUNCTION vns.admin_assert_live_price_reviewer(uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION vns.admin_review_live_provider_price_as_editor(
 uuid,integer,text,text,text,bigint,bigint,bigint,timestamptz,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION vns.admin_review_live_provider_fx_as_editor(
 uuid,integer,bigint,timestamptz,text) FROM PUBLIC;

ALTER FUNCTION vns.admin_assert_live_price_reviewer(uuid,integer)
 OWNER TO vns_provider_config_executor;
ALTER FUNCTION vns.admin_review_live_provider_price_as_editor(
 uuid,integer,text,text,text,bigint,bigint,bigint,timestamptz,text)
 OWNER TO vns_provider_config_executor;
ALTER FUNCTION vns.admin_review_live_provider_fx_as_editor(
 uuid,integer,bigint,timestamptz,text)
 OWNER TO vns_provider_config_executor;

-- Important: only the definer can run the actor helper, never the writer.
GRANT EXECUTE ON FUNCTION vns.admin_review_live_provider_price_as_editor(
 uuid,integer,text,text,text,bigint,bigint,bigint,timestamptz,text)
 TO vns_provider_config_writer;
GRANT EXECUTE ON FUNCTION vns.admin_review_live_provider_fx_as_editor(
 uuid,integer,bigint,timestamptz,text)
 TO vns_provider_config_writer;

COMMENT ON TABLE vns.provider_live_named_price_reviews IS
 'Immutable personally attributed offline price/FX reviews. No authorization to enable vendor calls, FX policy or spending.';
INSERT INTO vns.schema_migrations(version) VALUES ('0041_named_live_price_fx_reviews');
COMMIT;
