-- P2-04/P2-08: append-only, individually authenticated checkpoint evidence.
-- Not a publishing decision; empty and inaccessible without separately enrolled DB logins.
BEGIN;
CREATE TABLE vns.editorial_checkpoint_log (
  event_id uuid NOT NULL REFERENCES vns.research_events(event_id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 10000),
  stage text NOT NULL CHECK(stage IN
    ('ranking','claim_review','freshness','script_revision','quality')),
  outcome text NOT NULL CHECK(outcome IN ('candidate','blocked','needs_review')),
  actor_id uuid NOT NULL REFERENCES vns.editor_accounts(id) ON DELETE RESTRICT,
  actor_auth_version integer NOT NULL CHECK(actor_auth_version >= 0),
  artifact_sha256 text NOT NULL CHECK(artifact_sha256 ~ '^[0-9a-f]{64}$'),
  reason_codes jsonb NOT NULL CHECK(jsonb_typeof(reason_codes)='array'
    AND jsonb_array_length(reason_codes) BETWEEN 1 AND 20
    AND octet_length(reason_codes::text) <= 1024),
  score integer CHECK(score IS NULL OR score BETWEEN 0 AND 1000),
  previous_sha256 text NOT NULL CHECK(previous_sha256 ~ '^[0-9a-f]{64}$'),
  chain_sha256 text NOT NULL CHECK(chain_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(event_id,revision)
);
CREATE INDEX editorial_checkpoint_actor_idx
 ON vns.editorial_checkpoint_log(actor_id,recorded_at);
CREATE TRIGGER editorial_checkpoint_append_only
  BEFORE UPDATE OR DELETE ON vns.editorial_checkpoint_log
  FOR EACH ROW EXECUTE FUNCTION vns.refuse_editorial_timeline_mutation();
REVOKE ALL ON vns.editorial_checkpoint_log FROM PUBLIC;
GRANT SELECT,INSERT ON vns.editorial_checkpoint_log TO vns_p2_named_executor;

CREATE FUNCTION vns.named_append_editorial_checkpoint(
  p_event uuid,p_expected integer,p_stage text,p_outcome text,
  p_digest text,p_codes jsonb,p_score integer
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $body$
DECLARE
  v_actor uuid;
  v_version integer;
  v_role text;
  v_last integer;
  v_prev text;
  v_created integer;
  v_author uuid;
BEGIN
  SELECT p.editor_id,p.auth_version,a.role INTO v_actor,v_version,v_role
  FROM vns.editor_db_principals p
  JOIN vns.editor_accounts a ON a.id=p.editor_id
  WHERE p.login_role=session_user AND p.active=true
    AND a.active=true AND a.auth_version=p.auth_version
    AND a.role IN ('admin','editor','reviewer');
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'named editorial checkpoint login denied' USING ERRCODE='42501';
  END IF;
  IF p_event IS NULL OR p_expected IS NULL OR p_expected NOT BETWEEN 0 AND 9999
    OR p_stage NOT IN ('ranking','claim_review','freshness','script_revision','quality')
    OR p_outcome NOT IN ('candidate','blocked','needs_review')
    OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$'
    OR p_codes IS NULL OR jsonb_typeof(p_codes) <> 'array'
    OR jsonb_array_length(p_codes) NOT BETWEEN 1 AND 20
    OR octet_length(p_codes::text) > 1024
    OR (p_score IS NOT NULL AND p_score NOT BETWEEN 0 AND 1000)
  THEN
    RAISE EXCEPTION 'editorial checkpoint shape invalid' USING ERRCODE='22023';
  END IF;
  IF EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_codes) AS x(value)
    WHERE jsonb_typeof(x.value) <> 'string'
      OR x.value#>>'{}' !~ '^[a-z][a-z0-9_]{1,39}$'
  ) THEN
    RAISE EXCEPTION 'editorial checkpoint reason invalid' USING ERRCODE='22023';
  END IF;
  IF (p_stage IN ('claim_review','quality') AND v_role NOT IN ('admin','reviewer'))
    OR (p_stage='script_revision' AND v_role NOT IN ('admin','editor'))
  THEN
    RAISE EXCEPTION 'editorial checkpoint reviewer separation' USING ERRCODE='42501';
  END IF;
  IF p_stage='quality' THEN
    SELECT actor_id INTO v_author FROM vns.editorial_checkpoint_log
    WHERE event_id=p_event AND stage='script_revision'
    ORDER BY revision DESC LIMIT 1;
    IF v_author IS NULL OR v_author=v_actor THEN
      RAISE EXCEPTION 'independent script reviewer required' USING ERRCODE='42501';
    END IF;
  END IF;
  SELECT revision,chain_sha256 INTO v_last,v_prev
  FROM vns.editorial_checkpoint_log WHERE event_id=p_event
  ORDER BY revision DESC LIMIT 1;
  IF coalesce(v_last,0) <> p_expected THEN RETURN false; END IF;
  v_prev := coalesce(v_prev,repeat('0',64));
  INSERT INTO vns.editorial_checkpoint_log (
    event_id,revision,stage,outcome,actor_id,actor_auth_version,
    artifact_sha256,reason_codes,score,previous_sha256,chain_sha256
  ) VALUES (
    p_event,p_expected+1,p_stage,p_outcome,v_actor,v_version,
    p_digest,p_codes,p_score,v_prev,
    encode(sha256(convert_to(
      v_prev||':'||p_event::text||':'||(p_expected+1)::text||':'||
      p_stage||':'||p_outcome||':'||v_actor::text||':'||
      p_digest||':'||p_codes::text||':'||coalesce(p_score::text,'null'),
      'UTF8')),'hex')
  ) ON CONFLICT (event_id,revision) DO NOTHING
  RETURNING revision INTO v_created;
  RETURN v_created IS NOT NULL;
END;
$body$;

CREATE FUNCTION vns.named_read_editorial_checkpoints(
  p_event uuid,p_after integer,p_limit integer
) RETURNS TABLE(
  revision integer,stage text,outcome text,actor_id uuid,
  artifact_sha256 text,reason_codes jsonb,score integer,
  previous_sha256 text,chain_sha256 text,recorded_at timestamptz
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog AS $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vns.editor_db_principals p
    JOIN vns.editor_accounts a ON a.id=p.editor_id
    WHERE p.login_role=session_user AND p.active=true
      AND a.active=true AND a.auth_version=p.auth_version
      AND a.role IN ('admin','reviewer')
  ) THEN
    RAISE EXCEPTION 'named checkpoint reader denied' USING ERRCODE='42501';
  END IF;
  IF p_event IS NULL OR p_after IS NULL OR p_after < 0
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
  THEN RAISE EXCEPTION 'checkpoint export query invalid' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT c.revision,c.stage,c.outcome,c.actor_id,
    c.artifact_sha256,c.reason_codes,c.score,
    c.previous_sha256,c.chain_sha256,c.recorded_at
  FROM vns.editorial_checkpoint_log c
  WHERE c.event_id=p_event AND c.revision>p_after
  ORDER BY c.revision LIMIT p_limit;
END;
$body$;

REVOKE ALL ON FUNCTION vns.named_append_editorial_checkpoint(
  uuid,integer,text,text,text,jsonb,integer),
  vns.named_read_editorial_checkpoints(uuid,integer,integer) FROM PUBLIC;
ALTER FUNCTION vns.named_append_editorial_checkpoint(
  uuid,integer,text,text,text,jsonb,integer) OWNER TO vns_p2_named_executor;
ALTER FUNCTION vns.named_read_editorial_checkpoints(
  uuid,integer,integer) OWNER TO vns_p2_named_executor;
GRANT EXECUTE ON FUNCTION vns.named_append_editorial_checkpoint(
  uuid,integer,text,text,text,jsonb,integer),
  vns.named_read_editorial_checkpoints(uuid,integer,integer)
  TO vns_p2_named_client;
INSERT INTO vns.schema_migrations(version) VALUES('0030_editorial_checkpoints');
COMMIT;
