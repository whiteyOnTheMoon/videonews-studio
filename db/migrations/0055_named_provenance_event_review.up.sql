-- P2-A 0055: named, append-only reviews of publisher provenance and event factors.
-- Metadata review is not a source license, independent claim proof or publishing.
BEGIN;
GRANT INSERT ON vns.feed_publisher_provenance_reviews,
  vns.feed_event_factor_reviews TO vns_p2_named_executor;

CREATE FUNCTION vns.named_publisher_review_read(p_source text)
RETURNS TABLE(source_revision bigint,reviewed boolean,publisher_group text,quality integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $body$
DECLARE actor uuid; sources jsonb; source_record jsonb; v_source_rev bigint;
BEGIN
  SELECT principal.editor_id INTO actor
    FROM vns.editor_db_principals principal
    JOIN vns.editor_accounts account ON account.id=principal.editor_id
    WHERE principal.login_role=session_user AND principal.active=true
      AND account.active=true AND account.role='admin'
      AND account.auth_version=principal.auth_version;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Named publisher review forbidden' USING ERRCODE='42501';
  END IF;
  IF p_source IS NULL OR p_source !~ '^[a-z][a-z0-9_-]{2,40}$'
  THEN RAISE EXCEPTION 'Publisher review source invalid' USING ERRCODE='22023'; END IF;
  SELECT registry.revision,registry.sources INTO v_source_rev,sources
    FROM vns.admin_source_registry registry WHERE singleton=true;
  SELECT item.value INTO source_record
    FROM jsonb_array_elements(sources) item(value)
    WHERE item.value->>'id'=p_source AND item.value->>'status'='approved'
      AND vns.feed_runtime_source_authorized(item.value);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source lacks reviewed authorization' USING ERRCODE='42501';
  END IF;
  SELECT p.publisher_group,p.quality INTO publisher_group,quality
    FROM vns.feed_publisher_provenance_reviews p
    WHERE p.source_id=p_source AND p.source_revision=v_source_rev;
  reviewed:=FOUND;
  source_revision:=v_source_rev;
  RETURN NEXT;
END;
$body$;

CREATE FUNCTION vns.named_publisher_review_commit(
  p_source text,p_source_revision bigint,p_group text,p_quality integer
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $body$
DECLARE actor uuid; current_revision bigint; sources jsonb; source_record jsonb; inserted text;
BEGIN
  SELECT principal.editor_id INTO actor
    FROM vns.editor_db_principals principal
    JOIN vns.editor_accounts account ON account.id=principal.editor_id
    WHERE principal.login_role=session_user AND principal.active=true
      AND account.active=true AND account.role='admin'
      AND account.auth_version=principal.auth_version;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Named publisher reviewer forbidden' USING ERRCODE='42501';
  END IF;
  IF p_source IS NULL OR p_source !~ '^[a-z][a-z0-9_-]{2,40}$'
     OR p_source_revision IS NULL OR p_source_revision<1
     OR p_group IS NULL OR p_group !~ '^[a-z][a-z0-9_-]{2,40}$'
     OR p_quality IS NULL OR p_quality NOT BETWEEN 0 AND 5
  THEN RAISE EXCEPTION 'Publisher review metadata invalid' USING ERRCODE='22023'; END IF;
  -- Prevent concurrent source/host revocation while writing provenance.
  SELECT registry.revision,registry.sources INTO current_revision,sources
    FROM vns.admin_source_registry registry WHERE singleton=true FOR SHARE;
  IF current_revision IS DISTINCT FROM p_source_revision THEN RETURN false; END IF;
  SELECT item.value INTO source_record
    FROM jsonb_array_elements(sources) item(value)
    WHERE item.value->>'id'=p_source AND item.value->>'status'='approved'
      AND vns.feed_runtime_source_authorized(item.value);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Publisher source authorization unavailable' USING ERRCODE='42501';
  END IF;
  INSERT INTO vns.feed_publisher_provenance_reviews(
    source_id,source_revision,publisher_group,quality,reviewer_id
  ) VALUES (p_source,current_revision,p_group,p_quality,actor)
  ON CONFLICT DO NOTHING RETURNING source_id INTO inserted;
  RETURN inserted IS NOT NULL;
END;
$body$;

CREATE FUNCTION vns.named_event_factor_review_read(p_event uuid,p_profile text)
RETURNS TABLE(profile_revision bigint,policy_revision bigint,reviewed boolean,
  explanatory_value integer,visualizability integer,risk integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $body$
DECLARE actor uuid; v_profile_rev bigint; v_policy_rev bigint;
BEGIN
  SELECT principal.editor_id INTO actor
    FROM vns.editor_db_principals principal
    JOIN vns.editor_accounts account ON account.id=principal.editor_id
    WHERE principal.login_role=session_user AND principal.active=true
      AND account.active=true AND account.role='admin'
      AND account.auth_version=principal.auth_version;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Named event review forbidden' USING ERRCODE='42501';
  END IF;
  IF p_event IS NULL OR p_profile IS NULL
      OR p_profile !~ '^[a-z][a-z0-9_-]{2,40}$'
  THEN RAISE EXCEPTION 'Event review request invalid' USING ERRCODE='22023'; END IF;
  SELECT registry.revision INTO v_profile_rev
    FROM vns.editorial_profile_registry registry
    WHERE singleton=true AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(registry.profiles) profile
      WHERE profile.value->>'id'=p_profile
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Editorial profile not available' USING ERRCODE='22023';
  END IF;
  SELECT max(policy.revision) INTO v_policy_rev
    FROM vns.feed_ranking_policy_reviews policy
    WHERE policy.profile_id=p_profile
      AND policy.profile_revision=v_profile_rev;
  IF v_policy_rev IS NULL THEN
    RAISE EXCEPTION 'Reviewed ranking policy required' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM vns.research_event_articles ea
    WHERE ea.event_id=p_event
  ) THEN
    RAISE EXCEPTION 'Event has no provenance' USING ERRCODE='22023';
  END IF;
  SELECT factor.explanatory_value,factor.visualizability,factor.risk
    INTO explanatory_value,visualizability,risk
    FROM vns.feed_event_factor_reviews factor
    WHERE factor.event_id=p_event AND factor.profile_id=p_profile
      AND factor.profile_revision=v_profile_rev
      AND factor.policy_revision=v_policy_rev;
  reviewed:=FOUND;
  profile_revision:=v_profile_rev;
  policy_revision:=v_policy_rev;
  RETURN NEXT;
END;
$body$;

CREATE FUNCTION vns.named_event_factor_review_commit(
  p_event uuid,p_profile text,p_profile_revision bigint,p_policy_revision bigint,
  p_explanation integer,p_visual integer,p_risk integer
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $body$
DECLARE actor uuid; current_profile bigint; current_policy bigint; inserted uuid;
BEGIN
  SELECT principal.editor_id INTO actor
    FROM vns.editor_db_principals principal
    JOIN vns.editor_accounts account ON account.id=principal.editor_id
    WHERE principal.login_role=session_user AND principal.active=true
      AND account.active=true AND account.role='admin'
      AND account.auth_version=principal.auth_version;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Named event reviewer forbidden' USING ERRCODE='42501';
  END IF;
  IF p_event IS NULL OR p_profile IS NULL
      OR p_profile !~ '^[a-z][a-z0-9_-]{2,40}$'
      OR p_profile_revision IS NULL OR p_profile_revision<0
      OR p_policy_revision IS NULL OR p_policy_revision<1
      OR p_explanation IS NULL OR p_explanation NOT BETWEEN 0 AND 5
      OR p_visual IS NULL OR p_visual NOT BETWEEN 0 AND 5
      OR p_risk IS NULL OR p_risk NOT BETWEEN 0 AND 5
  THEN RAISE EXCEPTION 'Event factor review invalid' USING ERRCODE='22023'; END IF;
  -- Serialize with policy writes and refuse a stale policy/profile snapshot.
  PERFORM pg_advisory_xact_lock(721214,54);
  SELECT registry.revision INTO current_profile
    FROM vns.editorial_profile_registry registry
    WHERE singleton=true AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(registry.profiles) profile
      WHERE profile.value->>'id'=p_profile
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Editorial profile not available' USING ERRCODE='22023';
  END IF;
  SELECT max(policy.revision) INTO current_policy
    FROM vns.feed_ranking_policy_reviews policy
    WHERE policy.profile_id=p_profile
      AND policy.profile_revision=current_profile;
  IF current_profile<>p_profile_revision OR current_policy IS DISTINCT FROM p_policy_revision
  THEN RETURN false; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM vns.research_event_articles ea WHERE ea.event_id=p_event
  ) THEN RAISE EXCEPTION 'No projected event evidence' USING ERRCODE='22023'; END IF;
  -- This review cannot attest a withdrawn, pending or unapproved source.
  IF EXISTS(
    SELECT 1 FROM vns.research_event_articles ea
    JOIN vns.research_articles article ON article.article_id=ea.article_id
    WHERE ea.event_id=p_event AND NOT EXISTS(
      SELECT 1 FROM vns.admin_source_registry registry
      CROSS JOIN LATERAL jsonb_array_elements(registry.sources) source(value)
      WHERE registry.singleton=true AND source.value->>'id'=article.source_key
        AND vns.feed_runtime_source_authorized(source.value)
    )
  ) THEN
    RAISE EXCEPTION 'Event contains unapproved source' USING ERRCODE='42501';
  END IF;
  INSERT INTO vns.feed_event_factor_reviews(
    event_id,profile_id,profile_revision,policy_revision,
    explanatory_value,visualizability,risk,reviewer_id
  ) VALUES(
    p_event,p_profile,current_profile,current_policy,
    p_explanation,p_visual,p_risk,actor
  ) ON CONFLICT DO NOTHING RETURNING event_id INTO inserted;
  RETURN inserted IS NOT NULL;
END;
$body$;

REVOKE ALL ON FUNCTION
  vns.named_publisher_review_read(text),
  vns.named_publisher_review_commit(text,bigint,text,integer),
  vns.named_event_factor_review_read(uuid,text),
  vns.named_event_factor_review_commit(uuid,text,bigint,bigint,integer,integer,integer)
FROM PUBLIC;
ALTER FUNCTION vns.named_publisher_review_read(text) OWNER TO vns_p2_named_executor;
ALTER FUNCTION vns.named_publisher_review_commit(text,bigint,text,integer)
  OWNER TO vns_p2_named_executor;
ALTER FUNCTION vns.named_event_factor_review_read(uuid,text)
  OWNER TO vns_p2_named_executor;
ALTER FUNCTION vns.named_event_factor_review_commit(uuid,text,bigint,bigint,integer,integer,integer)
  OWNER TO vns_p2_named_executor;
GRANT EXECUTE ON FUNCTION
  vns.named_publisher_review_read(text),
  vns.named_publisher_review_commit(text,bigint,text,integer),
  vns.named_event_factor_review_read(uuid,text),
  vns.named_event_factor_review_commit(uuid,text,bigint,bigint,integer,integer,integer)
TO vns_p2_named_client;

INSERT INTO vns.schema_migrations(version) VALUES('0055_named_provenance_event_review');
COMMIT;
