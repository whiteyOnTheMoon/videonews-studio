-- P1-09 #227/#230: change model selection from synthetic static
-- IDs to a database-backed, personally reviewed provider-price catalog.
-- Applies only after 0041. No transport or paid-request activation.
BEGIN;
GRANT SELECT ON vns.provider_live_named_price_reviews
  TO vns_provider_config_executor;

CREATE OR REPLACE FUNCTION vns.admin_mutate_ai_provider(
  p_provider text, p_action text, p_model text,
  p_nonce bytea, p_ciphertext bytea, p_tag bytea
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, vns, pg_temp
AS $mutate$
DECLARE
  v_stored_model text;
  v_allowed boolean;
BEGIN
  IF p_provider IS NULL OR p_action IS NULL
     OR p_provider NOT IN ('openai','google_gemini')
     OR p_action NOT IN ('set_key','remove_key','set_model') THEN
    RAISE EXCEPTION 'invalid provider mutation' USING ERRCODE='22023';
  END IF;

  -- Lock the provider row: rotations, removals and metadata changes
  -- for this provider must be serialized in this same transaction.
  SELECT selected_model INTO v_stored_model
  FROM vns.ai_provider_settings
  WHERE provider=p_provider AND enabled=false FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider unavailable or active' USING ERRCODE='22023';
  END IF;

  IF p_action='set_key' THEN
    IF p_model IS NOT NULL OR p_nonce IS NULL OR p_ciphertext IS NULL
       OR p_tag IS NULL OR octet_length(p_nonce)<>12
       OR octet_length(p_ciphertext) NOT BETWEEN 12 AND 512
       OR octet_length(p_tag)<>16 THEN
      RAISE EXCEPTION 'invalid sealed key envelope' USING ERRCODE='22023';
    END IF;
    -- No plaintext ever enters PostgreSQL. Audited upsert and event
    -- are in one statement transaction; any failure rolls all back.
    INSERT INTO vns.ai_provider_sealed_credentials
      (provider,format_version,nonce,ciphertext,auth_tag,changed_at)
    VALUES(p_provider,1,p_nonce,p_ciphertext,p_tag,clock_timestamp())
    ON CONFLICT(provider) DO UPDATE SET
      format_version=1, nonce=EXCLUDED.nonce,
      ciphertext=EXCLUDED.ciphertext,auth_tag=EXCLUDED.auth_tag,
      changed_at=clock_timestamp();
  ELSIF p_action='remove_key' THEN
    IF p_model IS NOT NULL OR p_nonce IS NOT NULL OR p_ciphertext IS NOT NULL
       OR p_tag IS NOT NULL THEN
      RAISE EXCEPTION 'invalid key removal' USING ERRCODE='22023';
    END IF;
    DELETE FROM vns.ai_provider_sealed_credentials
    WHERE provider=p_provider;
  ELSE
    IF p_model IS NULL OR p_nonce IS NOT NULL OR p_ciphertext IS NOT NULL
       OR p_tag IS NOT NULL THEN
      RAISE EXCEPTION 'invalid model mutation' USING ERRCODE='22023';
    END IF;
    -- Selection requires an immutable, personally reviewed, unexpired
    -- pricing snapshot for THIS provider and model. No arbitrary model IDs,
    -- unreviewed rows, stale prices or revoked price reviewers.
    v_allowed := p_model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}
    IF NOT COALESCE(v_allowed,false) THEN
      RAISE EXCEPTION 'model not allowlisted' USING ERRCODE='22023';
    END IF;
    UPDATE vns.ai_provider_settings
       SET selected_model=p_model,updated_at=clock_timestamp()
     WHERE provider=p_provider;
  END IF;

  -- Fixed, truthful attribution: the current shared admin session
  -- does not identify a specific human; do not fabricate user identity.
  INSERT INTO vns.ai_provider_config_events(provider,action,database_login)
    VALUES(p_provider,p_action,session_user);
END;
$mutate$;
      AND EXISTS (
        SELECT 1
          FROM vns.provider_live_price_snapshots AS price
          JOIN vns.provider_live_named_price_reviews AS review
            ON review.kind='model_price' AND review.snapshot_id=price.id
          JOIN vns.editor_accounts AS actor
            ON actor.id=review.editor_id
         WHERE price.provider=p_provider AND price.model=p_model
           AND price.currency='USD'
           AND price.expires_at>clock_timestamp()
           AND price.reviewed_at<=clock_timestamp()
           AND price.reviewed_at>=clock_timestamp()-interval '7 days'
           AND actor.role='admin' AND actor.active=true
           AND actor.auth_version=review.editor_auth_version
      );
    IF NOT COALESCE(v_allowed,false) THEN
      RAISE EXCEPTION 'model not allowlisted' USING ERRCODE='22023';
    END IF;
    UPDATE vns.ai_provider_settings
       SET selected_model=p_model,updated_at=clock_timestamp()
     WHERE provider=p_provider;
  END IF;

  -- Fixed, truthful attribution: the current shared admin session
  -- does not identify a specific human; do not fabricate user identity.
  INSERT INTO vns.ai_provider_config_events(provider,action,database_login)
    VALUES(p_provider,p_action,session_user);
END;
$mutate$;

INSERT INTO vns.schema_migrations(version)
VALUES('0042_provider_reviewed_model_selection');
COMMIT;
