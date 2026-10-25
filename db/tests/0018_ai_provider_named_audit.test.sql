-- P1-09 disposable CI: personal audit requires an active, versioned admin.
BEGIN;
DO $acl$
BEGIN
  IF (SELECT count(*) FROM vns.schema_migrations
      WHERE version='0018_ai_provider_named_audit')<>1
    OR (SELECT count(*) FROM vns.ai_provider_named_config_events)<>0 THEN
    RAISE EXCEPTION 'Named provider audit migration absent or seeded';
  END IF;
  IF has_function_privilege('vns_provider_config_writer',
       'vns.admin_mutate_ai_provider(text,text,text,bytea,bytea,bytea)','EXECUTE')
    OR NOT has_function_privilege('vns_provider_config_writer',
       'vns.admin_mutate_ai_provider_as_editor(text,text,text,bytea,bytea,bytea,uuid,integer)',
       'EXECUTE')
    OR has_function_privilege('vns_api_runtime',
       'vns.admin_mutate_ai_provider_as_editor(text,text,text,bytea,bytea,bytea,uuid,integer)',
       'EXECUTE')
    OR has_function_privilege('vns_research_writer',
       'vns.admin_mutate_ai_provider_as_editor(text,text,text,bytea,bytea,bytea,uuid,integer)',
       'EXECUTE')
    OR has_table_privilege('vns_provider_config_writer',
       'vns.ai_provider_named_config_events','INSERT')
    OR has_table_privilege('vns_provider_config_writer',
       'vns.editor_accounts','SELECT')
    OR has_table_privilege('vns_provider_config_writer',
       'vns.editor_accounts','UPDATE')
    OR NOT has_table_privilege('vns_audit_reader',
       'vns.ai_provider_named_config_events','SELECT')
  THEN RAISE EXCEPTION 'Named provider ACL not fail-closed'; END IF;
  IF (SELECT pg_get_userbyid(proowner) FROM pg_proc
     WHERE oid='vns.admin_mutate_ai_provider_as_editor(
       text,text,text,bytea,bytea,bytea,uuid,integer)'::regprocedure)
       <>'vns_provider_config_executor'
    OR NOT (SELECT prosecdef FROM pg_proc
     WHERE oid='vns.admin_mutate_ai_provider_as_editor(
       text,text,text,bytea,bytea,bytea,uuid,integer)'::regprocedure)
  THEN RAISE EXCEPTION 'Named provider definer ownership incorrect'; END IF;
END;
$acl$;

-- All identities are synthetic and rolled back after this test transaction.
-- Migration 0010 registered session_user as a test-only account operator.
INSERT INTO vns.editor_accounts
 (id,username,display_name,role,password_hash,active)
VALUES
 ('baba1111-1111-4111-8111-111111111111','ci_named_provider_admin',
  'CI Named Provider Admin','admin',
  'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
 ('baba2222-2222-4222-8222-222222222222','ci_named_provider_editor',
  'CI Named Provider Editor','editor',
  'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);

SET LOCAL ROLE vns_provider_config_writer;
DO $writer$
DECLARE
  denied boolean;
BEGIN
  denied:=false;
  BEGIN
    PERFORM vns.admin_mutate_ai_provider(
     'openai','set_model','gpt-6-luna',NULL,NULL,NULL);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Legacy shared-session writer still executable'; END IF;

  denied:=false;
  BEGIN
    PERFORM vns.admin_mutate_ai_provider_as_editor(
      'openai','set_model','gpt-6-luna',NULL,NULL,NULL,
      'baba2222-2222-4222-8222-222222222222',0);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Editor was accepted as provider admin'; END IF;

  denied:=false;
  BEGIN
    PERFORM vns.admin_mutate_ai_provider_as_editor(
      'openai','set_model','gpt-6-luna',NULL,NULL,NULL,
      'baba1111-1111-4111-8111-111111111111',1);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Stale admin auth-version accepted'; END IF;

  denied:=false;
  BEGIN
    PERFORM vns.admin_mutate_ai_provider_as_editor(
      'openai','set_model','gpt-6-luna',NULL,NULL,NULL,
      'baba3333-3333-4333-8333-333333333333',0);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Missing admin accepted'; END IF;

  denied:=false;
  BEGIN
    PERFORM vns.admin_mutate_ai_provider_as_editor(
      'openai','set_model','gpt-6-luna',NULL,NULL,NULL,NULL,0);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Null admin accepted'; END IF;

  PERFORM vns.admin_mutate_ai_provider_as_editor(
    'openai','set_model','gpt-6-luna',NULL,NULL,NULL,
    'baba1111-1111-4111-8111-111111111111',0);

  denied:=false;
  BEGIN
    PERFORM vns.admin_mutate_ai_provider_as_editor(
      'google_gemini','set_model','gpt-6-luna',NULL,NULL,NULL,
      'baba1111-1111-4111-8111-111111111111',0);
  EXCEPTION WHEN invalid_parameter_value THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Invalid model mutation accepted'; END IF;

  denied:=false;
  BEGIN
    INSERT INTO vns.ai_provider_named_config_events(
       provider,action,editor_id,editor_username,editor_auth_version,database_login)
    VALUES('openai','set_model',
      'baba1111-1111-4111-8111-111111111111','forged_user',0,'forged_db');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Writer forged an audit entry'; END IF;
END;
$writer$;
RESET ROLE;

DO $verify$
DECLARE
  blocked boolean;
BEGIN
  IF (SELECT count(*) FROM vns.ai_provider_named_config_events)<>1
    OR (SELECT count(*) FROM vns.ai_provider_config_events)<>1
    OR NOT EXISTS(
      SELECT 1 FROM vns.ai_provider_named_config_events
      WHERE provider='openai' AND action='set_model'
       AND editor_id='baba1111-1111-4111-8111-111111111111'
       AND editor_username='ci_named_provider_admin'
       AND editor_auth_version=0 AND database_login=session_user)
    OR EXISTS(SELECT 1 FROM vns.ai_provider_settings WHERE enabled)
  THEN RAISE EXCEPTION 'Named and legacy audit mutation not atomic'; END IF;

  blocked:=false;
  BEGIN
    UPDATE vns.ai_provider_named_config_events SET editor_username='altered';
  EXCEPTION WHEN invalid_parameter_value THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Named audit history editable'; END IF;

  blocked:=false;
  BEGIN
    DELETE FROM vns.ai_provider_named_config_events;
  EXCEPTION WHEN invalid_parameter_value THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Named audit history deletable'; END IF;

  blocked:=false;
  BEGIN
    TRUNCATE vns.ai_provider_named_config_events;
  EXCEPTION WHEN invalid_parameter_value THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Named audit history truncatable'; END IF;
END;
$verify$;

-- Revocation must invalidate a previously accepted actor/version.
UPDATE vns.editor_accounts SET active=false
 WHERE id='baba1111-1111-4111-8111-111111111111';
SET LOCAL ROLE vns_provider_config_writer;
DO $revoked$
DECLARE
  denied boolean:=false;
BEGIN
  BEGIN
    PERFORM vns.admin_mutate_ai_provider_as_editor(
      'openai','remove_key',NULL,NULL,NULL,NULL,
      'baba1111-1111-4111-8111-111111111111',0);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Revoked named admin accepted'; END IF;
END;
$revoked$;
RESET ROLE;
DO $after$
BEGIN
  IF (SELECT count(*) FROM vns.ai_provider_named_config_events)<>1
    OR (SELECT count(*) FROM vns.ai_provider_config_events)<>1 THEN
    RAISE EXCEPTION 'Failed or revoked mutation created audit entry';
  END IF;
END;
$after$;
ROLLBACK;
