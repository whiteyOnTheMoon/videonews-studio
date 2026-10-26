-- P2-09/P2-10: dormant per-human authenticated PostgreSQL principal gateway.
-- No personal logins or memberships are installed by this migration.
BEGIN;
CREATE ROLE vns_p2_named_executor NOLOGIN NOINHERIT;
CREATE ROLE vns_p2_named_client NOLOGIN;
GRANT USAGE ON SCHEMA vns TO vns_p2_named_executor,vns_p2_named_client;

-- DBA-only binding: never writable by API, worker, or client. Empty by default.
CREATE TABLE vns.editor_db_principals (
  login_role name PRIMARY KEY,
  editor_id uuid NOT NULL UNIQUE REFERENCES vns.editor_accounts(id) ON DELETE RESTRICT,
  auth_version integer NOT NULL CHECK(auth_version >= 0),
  active boolean NOT NULL DEFAULT false,
  enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(login_role::text !~ '^(postgres|vns_|pg_)')
);
REVOKE ALL ON vns.editor_db_principals FROM PUBLIC;
GRANT SELECT ON vns.editor_db_principals,vns.editor_accounts,
  vns.editorial_profile_registry TO vns_p2_named_executor;
GRANT EXECUTE ON FUNCTION vns.commit_editorial_profiles(bigint,jsonb,uuid,integer),
  vns.append_editorial_timeline(uuid,text,uuid,integer,text,text,jsonb),
  vns.read_editorial_timeline(uuid,uuid,integer,integer)
  TO vns_p2_named_executor;

-- session_user is the LOGIN identity established by PostgreSQL authentication.
-- SET ROLE, cookie identity, custom GUCs or caller-supplied UUIDs cannot replace it.
CREATE FUNCTION vns.named_profile_commit(p_revision bigint,p_profiles jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $body$
DECLARE actor uuid; version integer;
BEGIN
  SELECT p.editor_id,p.auth_version INTO actor,version
  FROM vns.editor_db_principals p
  JOIN vns.editor_accounts a ON a.id=p.editor_id
  WHERE p.login_role=session_user AND p.active=true
    AND a.active=true AND a.auth_version=p.auth_version AND a.role='admin';
  IF actor IS NULL THEN
    RAISE EXCEPTION 'personal profile login not approved' USING ERRCODE='42501';
  END IF;
  RETURN vns.commit_editorial_profiles(p_revision,p_profiles,actor,version);
END;
$body$;

CREATE FUNCTION vns.named_profile_read()
RETURNS TABLE(revision bigint,profiles jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog AS $body$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM vns.editor_db_principals p
    JOIN vns.editor_accounts a ON a.id=p.editor_id
    WHERE p.login_role=session_user AND p.active=true
      AND a.active=true AND a.auth_version=p.auth_version AND a.role='admin'
  ) THEN
    RAISE EXCEPTION 'personal profile reader not approved' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT r.revision,r.profiles
    FROM vns.editorial_profile_registry r WHERE r.singleton=true;
END;
$body$;

CREATE FUNCTION vns.named_timeline_append(
  p_story uuid,p_kind text,p_reference text,p_digest text,p_details jsonb
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $body$
DECLARE actor uuid; version integer;
BEGIN
  SELECT p.editor_id,p.auth_version INTO actor,version
  FROM vns.editor_db_principals p
  JOIN vns.editor_accounts a ON a.id=p.editor_id
  WHERE p.login_role=session_user AND p.active=true
    AND a.active=true AND a.auth_version=p.auth_version
    AND a.role IN ('admin','editor','reviewer');
  IF actor IS NULL THEN
    RAISE EXCEPTION 'personal timeline writer not approved' USING ERRCODE='42501';
  END IF;
  RETURN vns.append_editorial_timeline(
    p_story,p_kind,actor,version,p_reference,p_digest,p_details
  );
END;
$body$;

CREATE FUNCTION vns.named_timeline_read(p_story uuid,p_limit integer)
RETURNS TABLE (
  event_id uuid,event_kind text,actor_id uuid,reference_uri text,
  document_sha256 text,details jsonb,recorded_at timestamptz
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog AS $body$
DECLARE actor uuid; version integer;
BEGIN
  SELECT p.editor_id,p.auth_version INTO actor,version
  FROM vns.editor_db_principals p
  JOIN vns.editor_accounts a ON a.id=p.editor_id
  WHERE p.login_role=session_user AND p.active=true
    AND a.active=true AND a.auth_version=p.auth_version
    AND a.role IN ('admin','reviewer');
  IF actor IS NULL THEN
    RAISE EXCEPTION 'personal timeline reader not approved' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT r.* FROM vns.read_editorial_timeline(
    p_story,actor,version,p_limit
  ) AS r;
END;
$body$;

REVOKE ALL ON FUNCTION vns.named_profile_commit(bigint,jsonb),
  vns.named_profile_read(),vns.named_timeline_append(uuid,text,text,text,jsonb),
  vns.named_timeline_read(uuid,integer) FROM PUBLIC;
ALTER FUNCTION vns.named_profile_commit(bigint,jsonb) OWNER TO vns_p2_named_executor;
ALTER FUNCTION vns.named_profile_read() OWNER TO vns_p2_named_executor;
ALTER FUNCTION vns.named_timeline_append(uuid,text,text,text,jsonb)
  OWNER TO vns_p2_named_executor;
ALTER FUNCTION vns.named_timeline_read(uuid,integer) OWNER TO vns_p2_named_executor;
GRANT EXECUTE ON FUNCTION vns.named_profile_commit(bigint,jsonb),
  vns.named_profile_read(),vns.named_timeline_append(uuid,text,text,text,jsonb),
  vns.named_timeline_read(uuid,integer) TO vns_p2_named_client;

COMMENT ON TABLE vns.editor_db_principals IS
 'DBA-controlled personally authenticated PostgreSQL LOGIN registry; empty by default. Never grant direct writes or shared login impersonation.';
INSERT INTO vns.schema_migrations(version) VALUES('0029_named_editor_db_gateway');
COMMIT;
