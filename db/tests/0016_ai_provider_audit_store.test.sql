-- Strict disposable-CI PostgreSQL role, crypto-envelope and audit tests.
BEGIN;
DO $verify$
DECLARE
  denied boolean;
  v_events integer;
BEGIN
  IF (SELECT count(*) FROM vns.schema_migrations
      WHERE version='0016_ai_provider_audit_store')<>1 THEN
    RAISE EXCEPTION 'Provider audit migration missing';
  END IF;
  IF (SELECT count(*) FROM vns.ai_provider_config_events)<>0 THEN
    RAISE EXCEPTION 'Provider audit improperly preseeded';
  END IF;
  IF EXISTS(SELECT 1 FROM vns.ai_provider_settings WHERE enabled)
     OR (SELECT count(*) FROM vns.ai_provider_sealed_credentials)<>0 THEN
    RAISE EXCEPTION 'Provider key or activation improperly preseeded';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles
            WHERE rolname IN ('vns_provider_config_writer',
                              'vns_provider_config_executor')
              AND (rolcanlogin OR rolsuper OR rolcreaterole)) THEN
    RAISE EXCEPTION 'Provider roles have dangerous privileges';
  END IF;
  IF has_table_privilege('vns_provider_config_writer','vns.ai_provider_settings','UPDATE')
    OR has_table_privilege('vns_provider_config_writer','vns.ai_provider_sealed_credentials','SELECT')
    OR has_table_privilege('vns_provider_config_writer','vns.ai_provider_config_events','INSERT')
    OR has_function_privilege('vns_api_runtime',
        'vns.admin_mutate_ai_provider(text,text,text,bytea,bytea,bytea)','EXECUTE')
    OR has_function_privilege('vns_research_writer',
        'vns.admin_mutate_ai_provider(text,text,text,bytea,bytea,bytea)','EXECUTE')
    OR has_function_privilege('vns_api_runtime',
        'vns.admin_list_ai_providers()','EXECUTE') THEN
    RAISE EXCEPTION 'Least-privilege provider gates failed';
  END IF;
  IF NOT has_function_privilege('vns_provider_config_writer',
       'vns.admin_mutate_ai_provider(text,text,text,bytea,bytea,bytea)','EXECUTE')
     OR NOT has_function_privilege('vns_provider_config_writer',
       'vns.admin_list_ai_providers()','EXECUTE') THEN
    RAISE EXCEPTION 'Dormant writer function grants missing';
  END IF;
END;
$verify$;

SET LOCAL ROLE vns_provider_config_writer;
DO $writer$
DECLARE
  v_count integer;
  v_denied boolean;
BEGIN
  SELECT count(*) INTO v_count FROM vns.admin_list_ai_providers();
  IF v_count<>2 THEN RAISE EXCEPTION 'Provider list result invalid'; END IF;

  -- Test-only synthetic bytes, not API key material.
  PERFORM vns.admin_mutate_ai_provider(
     'openai','set_key',NULL,
     decode(repeat('12',12),'hex'),decode(repeat('34',24),'hex'),
     decode(repeat('56',16),'hex'));
  PERFORM vns.admin_mutate_ai_provider(
     'openai','set_key',NULL,
     decode(repeat('21',12),'hex'),decode(repeat('43',24),'hex'),
     decode(repeat('65',16),'hex'));
  PERFORM vns.admin_mutate_ai_provider(
     'openai','set_model','gpt-6-luna',NULL,NULL,NULL);
  PERFORM vns.admin_mutate_ai_provider(
     'openai','remove_key',NULL,NULL,NULL,NULL);

  v_denied:=false;
  BEGIN
    PERFORM * FROM vns.ai_provider_sealed_credentials;
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Writer could read raw cipher table'; END IF;

  v_denied:=false;
  BEGIN
    INSERT INTO vns.ai_provider_config_events(provider,action,database_login)
    VALUES('openai','set_key','ci-forged-actor');
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Writer forged audit event'; END IF;

  v_denied:=false;
  BEGIN
    UPDATE vns.ai_provider_settings SET enabled=true WHERE provider='openai';
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Writer enabled paid API access'; END IF;

  v_denied:=false;
  BEGIN
    PERFORM vns.admin_mutate_ai_provider(
      'google_gemini','set_model','gpt-6-luna',NULL,NULL,NULL);
  EXCEPTION WHEN SQLSTATE '22023' THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Cross-provider model accepted'; END IF;

  v_denied:=false;
  BEGIN
    PERFORM vns.admin_mutate_ai_provider(
      'openai','set_key',NULL,decode('12','hex'),
      decode(repeat('34',24),'hex'),decode(repeat('56',16),'hex'));
  EXCEPTION WHEN SQLSTATE '22023' THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Malformed nonce accepted'; END IF;

  v_denied:=false;
  BEGIN
    PERFORM vns.admin_mutate_ai_provider(
      'openai','enable',NULL,NULL,NULL,NULL);
  EXCEPTION WHEN SQLSTATE '22023' THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Unapproved activation accepted'; END IF;

  v_denied:=false;
  BEGIN
    PERFORM vns.admin_mutate_ai_provider(
      'openai','set_model','gpt-6.1-sol',
      decode(repeat('12',12),'hex'),NULL,NULL);
  EXCEPTION WHEN SQLSTATE '22023' THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Unexpected cipher field on model update accepted'; END IF;
END;
$writer$;
RESET ROLE;

DO $final$
DECLARE
  blocked boolean;
BEGIN
  IF (SELECT count(*) FROM vns.ai_provider_config_events)<>4
    OR (SELECT count(*) FROM vns.ai_provider_sealed_credentials)<>0
    OR (SELECT selected_model FROM vns.ai_provider_settings WHERE provider='openai')<>'gpt-6-luna'
    OR EXISTS(SELECT 1 FROM vns.ai_provider_settings WHERE enabled)
    OR (SELECT count(DISTINCT action) FROM vns.ai_provider_config_events)<>3
    OR EXISTS(SELECT 1 FROM vns.ai_provider_config_events
              WHERE actor_context<>'shared-admin-session'
                 OR database_login<>'postgres') THEN
    RAISE EXCEPTION 'Audit and mutation were not atomic';
  END IF;

  blocked:=false;
  BEGIN
    UPDATE vns.ai_provider_config_events SET actor_context='shared-admin-session';
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Audit history changed'; END IF;
  blocked:=false;
  BEGIN
    DELETE FROM vns.ai_provider_config_events;
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Audit history erased'; END IF;
  blocked:=false;
  BEGIN
    TRUNCATE vns.ai_provider_config_events;
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Audit history truncated'; END IF;
END;
$final$;
ROLLBACK;
