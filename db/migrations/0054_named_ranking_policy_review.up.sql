-- P2-04 0054: personally attributed ranking-policy review via verified LOGIN.
-- Default remains unconfigured; no source rights or publishing activated.
BEGIN;
GRANT INSERT ON vns.feed_ranking_policy_reviews TO vns_p2_named_executor;

CREATE FUNCTION vns.named_ranking_policy_read(p_profile text)
RETURNS TABLE(profile_revision bigint,policy_revision bigint,settings jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $body$
DECLARE
  actor uuid;
  p_revision bigint;
BEGIN
  SELECT m.editor_id INTO actor
  FROM vns.editor_db_principals m
  JOIN vns.editor_accounts a ON a.id=m.editor_id
  WHERE m.login_role=session_user AND m.active=true
    AND a.active=true AND a.role='admin' AND a.auth_version=m.auth_version;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Named ranking review reader forbidden' USING ERRCODE='42501';
  END IF;
  IF p_profile IS NULL OR p_profile !~ '^[a-z][a-z0-9_-]{2,40}$'
  THEN RAISE EXCEPTION 'Invalid profile ID' USING ERRCODE='22023'; END IF;
  SELECT r.revision INTO p_revision FROM vns.editorial_profile_registry r
  WHERE r.singleton=true AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(r.profiles) p
    WHERE p.value->>'id'=p_profile);
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not available' USING ERRCODE='22023'; END IF;
  RETURN QUERY
    SELECT p_revision,COALESCE(pol.revision,0::bigint),
       CASE WHEN pol.revision IS NULL THEN NULL::jsonb
       ELSE jsonb_build_object(
         'minimumPublisherGroups',pol.minimum_publisher_groups,
         'relevanceWeight',pol.relevance_weight,
         'freshnessWeight',pol.freshness_weight,
         'qualityWeight',pol.quality_weight,
         'explanatoryWeight',pol.explanatory_weight,
         'visualizabilityWeight',pol.visualizability_weight,
         'riskWeight',pol.risk_weight,
         'maximumRisk',pol.maximum_risk)
       END
    FROM (SELECT 1) dummy
    LEFT JOIN LATERAL (
      SELECT * FROM vns.feed_ranking_policy_reviews p
      WHERE p.profile_id=p_profile AND p.profile_revision=p_revision
      ORDER BY p.revision DESC LIMIT 1
    ) pol ON true;
END;
$body$;

CREATE FUNCTION vns.named_ranking_policy_commit(
  p_profile text,p_expected bigint,p_settings jsonb
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $body$
DECLARE
  actor uuid;
  p_revision bigint;
  latest bigint;
  key text;
  item integer;
BEGIN
  -- PostgreSQL session_user, never an HTTP claim or SET ROLE impersonation.
  SELECT m.editor_id INTO actor
  FROM vns.editor_db_principals m
  JOIN vns.editor_accounts a ON a.id=m.editor_id
  WHERE m.login_role=session_user AND m.active=true
    AND a.active=true AND a.role='admin' AND a.auth_version=m.auth_version
;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Named ranking reviewer forbidden' USING ERRCODE='42501';
  END IF;
  IF p_profile IS NULL OR p_profile !~ '^[a-z][a-z0-9_-]{2,40}$'
     OR p_expected IS NULL OR p_expected<0 OR p_expected>=9007199254740991
     OR p_settings IS NULL OR jsonb_typeof(p_settings)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_settings))<>8
     OR NOT (p_settings ?& ARRAY[
       'minimumPublisherGroups','relevanceWeight','freshnessWeight',
       'qualityWeight','explanatoryWeight','visualizabilityWeight',
       'riskWeight','maximumRisk'])
  THEN RAISE EXCEPTION 'Ranking policy request invalid' USING ERRCODE='22023'; END IF;

  FOREACH key IN ARRAY ARRAY[
    'minimumPublisherGroups','relevanceWeight','freshnessWeight',
    'qualityWeight','explanatoryWeight','visualizabilityWeight',
    'riskWeight','maximumRisk'] LOOP
    IF jsonb_typeof(p_settings->key)<>'number'
       OR (p_settings->>key) !~ '^(0|[1-9][0-9]*)$'
       OR length(p_settings->>key)>3
    THEN RAISE EXCEPTION 'Ranking weight invalid' USING ERRCODE='22023'; END IF;
    item:=(p_settings->>key)::integer;
    IF (key='minimumPublisherGroups' AND item NOT BETWEEN 2 AND 5)
       OR (key='maximumRisk' AND item NOT BETWEEN 0 AND 5)
       OR (key NOT IN ('minimumPublisherGroups','maximumRisk')
           AND item NOT BETWEEN 0 AND 100)
    THEN RAISE EXCEPTION 'Ranking weight out of bounds' USING ERRCODE='22023'; END IF;
  END LOOP;

  -- Serialize competing writes, including to a previously absent profile.
  -- Guarded session + transaction-wide lock, never table-access for client.
  PERFORM pg_advisory_xact_lock(721214,54);
  SELECT r.revision INTO p_revision
  FROM vns.editorial_profile_registry r
  WHERE r.singleton=true AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(r.profiles) p
    WHERE p.value->>'id'=p_profile);
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile no longer available' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(max(pol.revision),0) INTO latest
    FROM vns.feed_ranking_policy_reviews pol
    WHERE pol.profile_id=p_profile AND pol.profile_revision=p_revision;
  IF latest<>p_expected THEN RETURN false; END IF;
  INSERT INTO vns.feed_ranking_policy_reviews(
    profile_id,profile_revision,revision,minimum_publisher_groups,
    relevance_weight,freshness_weight,quality_weight,explanatory_weight,
    visualizability_weight,risk_weight,maximum_risk,reviewer_id
  ) VALUES(
    p_profile,p_revision,p_expected+1,
    (p_settings->>'minimumPublisherGroups')::integer,
    (p_settings->>'relevanceWeight')::integer,
    (p_settings->>'freshnessWeight')::integer,
    (p_settings->>'qualityWeight')::integer,
    (p_settings->>'explanatoryWeight')::integer,
    (p_settings->>'visualizabilityWeight')::integer,
    (p_settings->>'riskWeight')::integer,
    (p_settings->>'maximumRisk')::integer,actor
  );
  RETURN true;
END;
$body$;

REVOKE ALL ON FUNCTION vns.named_ranking_policy_read(text),
 vns.named_ranking_policy_commit(text,bigint,jsonb) FROM PUBLIC;
ALTER FUNCTION vns.named_ranking_policy_read(text) OWNER TO vns_p2_named_executor;
ALTER FUNCTION vns.named_ranking_policy_commit(text,bigint,jsonb)
  OWNER TO vns_p2_named_executor;
GRANT EXECUTE ON FUNCTION vns.named_ranking_policy_read(text),
 vns.named_ranking_policy_commit(text,bigint,jsonb) TO vns_p2_named_client;
INSERT INTO vns.schema_migrations(version) VALUES('0054_named_ranking_policy_review');
COMMIT;
