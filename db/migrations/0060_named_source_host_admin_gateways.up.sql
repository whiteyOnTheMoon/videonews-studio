-- P2-01: personally bound source and independently reviewed host SQL gateways.
-- Additive, default-off: no API wiring, source approval or feed activation.
BEGIN;

-- The existing source/host functions accept an asserted editor ID. Named
-- clients must never receive those functions directly. A SECURITY DEFINER
-- gateway resolves the actor from PostgreSQL session_user instead.
GRANT SELECT ON vns.admin_source_registry,
  vns.admin_source_host_approvals TO vns_p2_named_executor;
GRANT EXECUTE ON FUNCTION vns.admin_commit_source_registry(
  bigint,bigint,jsonb,text,text,uuid,integer,timestamptz),
  vns.admin_change_source_host_approval(
    bigint,bigint,text,text,text,uuid,integer)
  TO vns_p2_named_executor;

CREATE FUNCTION vns.named_source_actor()
RETURNS TABLE(actor_id uuid,actor_version integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog
AS $body$
BEGIN
  RETURN QUERY
    SELECT p.editor_id,p.auth_version
    FROM vns.editor_db_principals p
    JOIN vns.editor_accounts a ON a.id=p.editor_id
    WHERE p.login_role=session_user AND p.active=true
      AND a.active=true AND a.role='admin'
      AND a.auth_version=p.auth_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Personal source administrator unavailable'
      USING ERRCODE='42501';
  END IF;
END;
$body$;

CREATE FUNCTION vns.named_source_read()
RETURNS TABLE(revision bigint,sources jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog
AS $body$
BEGIN
  PERFORM * FROM vns.named_source_actor();
  RETURN QUERY SELECT r.revision,r.sources
    FROM vns.admin_source_registry r WHERE r.singleton=true;
END;
$body$;

CREATE FUNCTION vns.named_host_read()
RETURNS TABLE(revision bigint,approved_hosts jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog
AS $body$
BEGIN
  PERFORM * FROM vns.named_source_actor();
  RETURN QUERY SELECT h.revision,h.approved_hosts
    FROM vns.admin_source_host_approvals h WHERE h.singleton=true;
END;
$body$;

CREATE FUNCTION vns.named_source_commit(
  p_expected bigint,p_next bigint,p_sources jsonb,p_source_id text,p_action text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog
AS $body$
DECLARE v_actor uuid;v_version integer;
BEGIN
  SELECT x.actor_id,x.actor_version INTO v_actor,v_version
    FROM vns.named_source_actor() x;
  -- The legacy function retains its serial CAS and append-only audit.
  -- Its asserted actor identity is supplied ONLY from verified session_user.
  RETURN vns.admin_commit_source_registry(
    p_expected,p_next,p_sources,p_source_id,p_action,
    v_actor,v_version,clock_timestamp());
END;
$body$;

CREATE FUNCTION vns.named_host_change(
  p_expected bigint,p_source_revision bigint,p_action text,p_host text,p_reason text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog
AS $body$
DECLARE v_actor uuid;v_version integer;
BEGIN
  SELECT x.actor_id,x.actor_version INTO v_actor,v_version
    FROM vns.named_source_actor() x;
  -- 0023 still enforces another human as the source approver,
  -- under the source/host row locks. No exception for an owner account.
  RETURN vns.admin_change_source_host_approval(
    p_expected,p_source_revision,p_action,p_host,p_reason,
    v_actor,v_version);
END;
$body$;

REVOKE ALL ON FUNCTION
  vns.named_source_actor(),
  vns.named_source_read(),
  vns.named_host_read(),
  vns.named_source_commit(bigint,bigint,jsonb,text,text),
  vns.named_host_change(bigint,bigint,text,text,text)
  FROM PUBLIC;

ALTER FUNCTION vns.named_source_actor()
  OWNER TO vns_p2_named_executor;
ALTER FUNCTION vns.named_source_read()
  OWNER TO vns_p2_named_executor;
ALTER FUNCTION vns.named_host_read()
  OWNER TO vns_p2_named_executor;
ALTER FUNCTION vns.named_source_commit(bigint,bigint,jsonb,text,text)
  OWNER TO vns_p2_named_executor;
ALTER FUNCTION vns.named_host_change(bigint,bigint,text,text,text)
  OWNER TO vns_p2_named_executor;

-- No direct SELECT or UPDATE on registers to named client.
-- No direct EXECUTE on old actor-asserting functions to named client.
GRANT EXECUTE ON FUNCTION
  vns.named_source_actor(),
  vns.named_source_read(),
  vns.named_host_read(),
  vns.named_source_commit(bigint,bigint,jsonb,text,text),
  vns.named_host_change(bigint,bigint,text,text,text)
  TO vns_p2_named_client;

COMMENT ON FUNCTION vns.named_host_change(bigint,bigint,text,text,text)
IS 'Personal session_user plus immutable two-human host-grant requirement; no automatic feed activation.';

INSERT INTO vns.schema_migrations(version)
  VALUES('0060_named_source_host_admin_gateways');
COMMIT;
