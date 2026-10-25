-- CI-only assertions. No real API keys in PostgreSQL.
BEGIN;
DO $check$
DECLARE
  blocked boolean;
BEGIN
  IF (SELECT count(*) FROM vns.ai_provider_settings)<>2
     OR EXISTS(SELECT 1 FROM vns.ai_provider_settings WHERE enabled)
     OR (SELECT count(*) FROM vns.ai_provider_sealed_credentials)<>0
     OR (SELECT count(*) FROM vns.schema_migrations
         WHERE version='0015_ai_provider_admin_configuration')<>1 THEN
    RAISE EXCEPTION 'Provider configuration must be disabled and key-free';
  END IF;

  -- New providers/models can be configured only within a fixed provider allowlist.
  UPDATE vns.ai_provider_settings
    SET selected_model='gpt-6-luna' WHERE provider='openai';
  IF (SELECT selected_model FROM vns.ai_provider_settings
      WHERE provider='openai')<>'gpt-6-luna' THEN
    RAISE EXCEPTION 'Model metadata not editable';
  END IF;

  blocked := false;
  BEGIN
    UPDATE vns.ai_provider_settings SET enabled=true WHERE provider='openai';
  EXCEPTION WHEN check_violation THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Live provider activation possible'; END IF;
  blocked := false;
  BEGIN
    INSERT INTO vns.ai_provider_settings(provider) VALUES('other_provider');
  EXCEPTION WHEN check_violation THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Unknown provider accepted'; END IF;

  -- Simulated encryption envelope fixture (not an API key).
  INSERT INTO vns.ai_provider_sealed_credentials
    (provider, nonce, ciphertext, auth_tag)
    VALUES('openai',decode(repeat('ab',12),'hex'),
           decode(repeat('cd',24),'hex'),decode(repeat('ef',16),'hex'));
  IF (SELECT count(*) FROM vns.ai_provider_sealed_credentials)<>1 THEN
    RAISE EXCEPTION 'Sealed credential envelope not stored';
  END IF;

  blocked := false;
  BEGIN
    INSERT INTO vns.ai_provider_sealed_credentials
      (provider, nonce, ciphertext, auth_tag)
      VALUES('google_gemini',decode('ff','hex'),
        decode(repeat('aa',20),'hex'),decode(repeat('bb',16),'hex'));
  EXCEPTION WHEN check_violation THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Invalid nonce accepted'; END IF;

  IF has_table_privilege('vns_api_runtime','vns.ai_provider_sealed_credentials','SELECT')
     OR has_table_privilege('vns_api_runtime','vns.ai_provider_settings','UPDATE')
     OR has_table_privilege('vns_research_writer','vns.ai_provider_sealed_credentials','SELECT')
     OR has_table_privilege('vns_audit_reader','vns.ai_provider_sealed_credentials','SELECT')
     OR has_table_privilege('vns_job_status_sync','vns.ai_provider_sealed_credentials','INSERT')
  THEN RAISE EXCEPTION 'Existing runtime role can access provider keys'; END IF;
END;
$check$;
SET LOCAL ROLE vns_api_runtime;
DO $deny$
DECLARE
  blocked boolean := false;
BEGIN
  BEGIN
    PERFORM 1 FROM vns.ai_provider_sealed_credentials LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'API runtime read encrypted keys'; END IF;
END;
$deny$;
RESET ROLE;
ROLLBACK;
