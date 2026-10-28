-- P1-09/#227/#230: one secret-envelope read after an irreversible,
-- independently EUR-gated SQL dispatch claim. Offline only, NO LOGINs.
BEGIN;
CREATE ROLE vns_provider_secret_executor
 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE vns_provider_secret_reader
 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
GRANT USAGE ON SCHEMA vns TO
 vns_provider_secret_executor,vns_provider_secret_reader;

CREATE TABLE vns.provider_live_credential_reads (
 reservation_id uuid PRIMARY KEY REFERENCES vns.provider_live_reservations(id)
   ON DELETE RESTRICT,
 dispatch_claim_id uuid NOT NULL UNIQUE REFERENCES vns.provider_live_dispatch_claims(id)
   ON DELETE RESTRICT,
 provider text NOT NULL CHECK(provider IN ('openai','google_gemini')),
 credential_changed_at timestamptz NOT NULL,
 database_login name NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER reject_live_credential_read_change
 BEFORE UPDATE OR DELETE ON vns.provider_live_credential_reads
 FOR EACH ROW EXECUTE FUNCTION vns.reject_provider_usage_change();
CREATE TRIGGER reject_live_credential_read_truncate
 BEFORE TRUNCATE ON vns.provider_live_credential_reads
 FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_provider_usage_change();
GRANT SELECT,INSERT ON vns.provider_live_credential_reads
 TO vns_provider_secret_executor;
GRANT SELECT ON vns.provider_live_budget_policy,
 vns.provider_live_eur_policy,vns.provider_live_fx_snapshots,
 vns.provider_live_eur_admissions,vns.provider_live_reservations,
 vns.provider_live_dispatch_claims,vns.provider_live_settlements,
 vns.provider_live_price_snapshots,vns.provider_live_named_price_reviews,
 vns.ai_provider_sealed_credentials,vns.ai_provider_settings
 TO vns_provider_secret_executor;
GRANT SELECT(id,role,active,auth_version) ON vns.editor_accounts
 TO vns_provider_secret_executor;
GRANT SELECT ON vns.provider_live_credential_reads TO vns_audit_reader;

CREATE FUNCTION vns.claimed_provider_sealed_key(
 p_reservation_id uuid,p_provider text
) RETURNS TABLE (
 format_version integer, nonce bytea, ciphertext bytea, auth_tag bytea
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $secret$
DECLARE
 v_policy vns.provider_live_budget_policy%ROWTYPE;
 v_eur vns.provider_live_eur_policy%ROWTYPE;
 v_claim_id uuid;
 v_claimed_at timestamptz;
 v_key_changed_at timestamptz;
 v_rate_id uuid;
 v_fx_expires timestamptz;
 v_now timestamptz := clock_timestamp();
 v_read_id uuid;
BEGIN
 IF p_reservation_id IS NULL OR p_provider IS NULL OR
    p_provider NOT IN ('openai','google_gemini') THEN
   RAISE EXCEPTION 'Provider credential unavailable' USING ERRCODE='42501';
 END IF;
 -- Both policy locks preserve the same ordering as USD->EUR admission.
 SELECT * INTO STRICT v_policy FROM vns.provider_live_budget_policy
   WHERE singleton FOR UPDATE;
 SELECT * INTO STRICT v_eur FROM vns.provider_live_eur_policy
   WHERE singleton FOR UPDATE;
 IF NOT v_policy.enabled OR v_policy.halted OR NOT v_eur.enabled
    OR v_eur.global_cap_micro_eur NOT BETWEEN 1 AND 1000000
    OR v_eur.active_fx_snapshot_id IS NULL THEN
   RAISE EXCEPTION 'Provider credential unavailable' USING ERRCODE='42501';
 END IF;
 SELECT c.id,c.claimed_at,k.changed_at,a.fx_snapshot_id,fx.expires_at
   INTO v_claim_id,v_claimed_at,v_key_changed_at,v_rate_id,v_fx_expires
 FROM vns.provider_live_reservations AS r
 JOIN vns.provider_live_dispatch_claims AS c ON c.reservation_id=r.id
 JOIN vns.provider_live_eur_admissions AS a ON a.reservation_id=r.id
 JOIN vns.provider_live_fx_snapshots AS fx ON fx.id=a.fx_snapshot_id
 JOIN vns.provider_live_price_snapshots AS price ON price.id=r.price_snapshot_id
 JOIN vns.ai_provider_settings AS config
   ON config.provider=r.provider AND config.selected_model=r.model
 JOIN vns.ai_provider_sealed_credentials AS k ON k.provider=r.provider
 WHERE r.id=p_reservation_id AND r.provider=p_provider
   AND config.enabled=false
   AND price.provider=r.provider AND price.model=r.model
   AND price.expires_at>v_now
   AND EXISTS (
     SELECT 1 FROM vns.provider_live_named_price_reviews AS review
     JOIN vns.editor_accounts AS actor ON actor.id=review.editor_id
     WHERE review.kind='model_price' AND review.snapshot_id=price.id
       AND actor.role='admin' AND actor.active
       AND actor.auth_version=review.editor_auth_version
   )
   AND NOT EXISTS (
      SELECT 1 FROM vns.provider_live_settlements AS settlement
      WHERE settlement.reservation_id=r.id
   );
 IF NOT FOUND OR v_claimed_at IS NULL OR v_key_changed_at IS NULL
   OR v_key_changed_at > v_claimed_at OR v_rate_id IS DISTINCT FROM
      v_eur.active_fx_snapshot_id OR v_fx_expires <= v_now
   OR NOT EXISTS (
     SELECT 1 FROM vns.provider_live_fx_snapshots AS fx
     WHERE fx.id=v_rate_id AND fx.reviewed_at <= v_now
       AND fx.reviewed_at >= v_now-interval '24 hours'
   ) THEN
   RAISE EXCEPTION 'Provider credential unavailable' USING ERRCODE='42501';
 END IF;
 IF (SELECT count(*) FROM vns.provider_live_reservations)
   <> (SELECT count(*) FROM vns.provider_live_eur_admissions)
   OR (SELECT coalesce(sum(reserved_micro_eur),0)
       FROM vns.provider_live_eur_admissions) > v_eur.global_cap_micro_eur
 THEN
   RAISE EXCEPTION 'Provider credential unavailable' USING ERRCODE='42501';
 END IF;
 -- Exactly one successful read per claim, including competing SQL sessions.
 INSERT INTO vns.provider_live_credential_reads
   (reservation_id,dispatch_claim_id,provider,credential_changed_at,database_login)
 VALUES(p_reservation_id,v_claim_id,p_provider,v_key_changed_at,session_user)
 ON CONFLICT (reservation_id) DO NOTHING
 RETURNING reservation_id INTO v_read_id;
 IF v_read_id IS NULL THEN
   RAISE EXCEPTION 'Provider credential already accessed' USING ERRCODE='42501';
 END IF;
 RETURN QUERY
 SELECT k.format_version,k.nonce,k.ciphertext,k.auth_tag
   FROM vns.ai_provider_sealed_credentials AS k
   WHERE k.provider=p_provider AND k.changed_at=v_key_changed_at;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'Provider credential unavailable' USING ERRCODE='42501';
 END IF;
EXCEPTION WHEN no_data_found THEN
 RAISE EXCEPTION 'Provider credential unavailable' USING ERRCODE='42501';
END;
$secret$;

REVOKE ALL ON FUNCTION vns.claimed_provider_sealed_key(uuid,text) FROM PUBLIC;
ALTER FUNCTION vns.claimed_provider_sealed_key(uuid,text)
 OWNER TO vns_provider_secret_executor;
GRANT EXECUTE ON FUNCTION vns.claimed_provider_sealed_key(uuid,text)
 TO vns_provider_secret_reader;
COMMENT ON TABLE vns.provider_live_credential_reads IS
 'Immutable single-read claim-to-credential audit; ciphertext bytes are never stored here. Offline only.';
INSERT INTO vns.schema_migrations(version)
 VALUES('0043_claimed_provider_secret_scope');
COMMIT;
