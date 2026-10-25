-- Disposable CI-only least-privilege and five-per-minute admission tests.
BEGIN;
DO $setup$
BEGIN
  IF (SELECT count(*) FROM vns.schema_migrations
      WHERE version='0017_ai_provider_mutation_admission')<>1
    OR (SELECT count(*) FROM vns.ai_provider_mutation_window)<>1
    OR (SELECT attempts FROM vns.ai_provider_mutation_window
        WHERE singleton=true)<>0 THEN
    RAISE EXCEPTION 'Provider admission migration missing or dirty';
  END IF;
  IF has_table_privilege('vns_provider_config_writer',
       'vns.ai_provider_mutation_window','SELECT')
    OR has_table_privilege('vns_provider_config_writer',
       'vns.ai_provider_mutation_window','UPDATE')
    OR has_table_privilege('vns_api_runtime',
       'vns.ai_provider_mutation_window','SELECT')
    OR has_function_privilege('vns_api_runtime',
       'vns.admin_try_ai_provider_mutation_slot()','EXECUTE')
    OR has_function_privilege('vns_research_writer',
       'vns.admin_try_ai_provider_mutation_slot()','EXECUTE')
    OR NOT has_function_privilege('vns_provider_config_writer',
       'vns.admin_try_ai_provider_mutation_slot()','EXECUTE') THEN
    RAISE EXCEPTION 'Provider admission role privileges unsafe';
  END IF;
  IF (SELECT pg_get_userbyid(proowner) FROM pg_proc
      WHERE oid='vns.admin_try_ai_provider_mutation_slot()'::regprocedure)
       <>'vns_provider_config_executor'
    OR NOT (SELECT prosecdef FROM pg_proc
            WHERE oid='vns.admin_try_ai_provider_mutation_slot()'::regprocedure) THEN
    RAISE EXCEPTION 'Provider admission definer role incorrect';
  END IF;
END;
$setup$;

SET LOCAL ROLE vns_provider_config_writer;
DO $limits$
DECLARE
  v_ok boolean;
  v_denied boolean;
BEGIN
  FOR attempt IN 1..5 LOOP
    SELECT vns.admin_try_ai_provider_mutation_slot() INTO v_ok;
    IF v_ok IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Allowed mutation slot missing';
    END IF;
  END LOOP;
  SELECT vns.admin_try_ai_provider_mutation_slot() INTO v_ok;
  IF v_ok IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Sixth mutation attempt was accepted';
  END IF;
  -- Retry denial must not reset or refund capacity.
  SELECT vns.admin_try_ai_provider_mutation_slot() INTO v_ok;
  IF v_ok IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Repeated mutation attempt bypassed shared quota';
  END IF;
  v_denied:=false;
  BEGIN
    UPDATE vns.ai_provider_mutation_window SET attempts=0;
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Unprivileged writer reset shared provider quota';
  END IF;
  v_denied:=false;
  BEGIN
    DELETE FROM vns.ai_provider_mutation_window;
  EXCEPTION WHEN insufficient_privilege THEN v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Writer removed admission row'; END IF;
END;
$limits$;
RESET ROLE;

DO $failure$
DECLARE
  v_denied boolean:=false;
BEGIN
  -- A clock moving backwards must never open fresh slots.
  UPDATE vns.ai_provider_mutation_window
     SET window_started=clock_timestamp()+INTERVAL '10 minutes';
  IF vns.admin_try_ai_provider_mutation_slot() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Clock rollback reopened provider mutation slots';
  END IF;
  UPDATE vns.ai_provider_mutation_window
     SET window_started=clock_timestamp();

  -- A missing singleton must fail closed rather than mint a new one.
  -- The exception subtransaction rolls back the temporary DELETE.
  BEGIN
    DELETE FROM vns.ai_provider_mutation_window;
    PERFORM vns.admin_try_ai_provider_mutation_slot();
  EXCEPTION WHEN SQLSTATE '55000' THEN v_denied:=true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Missing provider admission row was tolerated';
  END IF;
END;
$failure$;

DO $final$
BEGIN
  IF (SELECT attempts FROM vns.ai_provider_mutation_window
       WHERE singleton=true)<>5
    OR (SELECT count(*) FROM vns.ai_provider_mutation_window)<>1
    OR EXISTS (SELECT 1 FROM vns.ai_provider_settings WHERE enabled) THEN
    RAISE EXCEPTION 'Provider admission mutated data incorrectly';
  END IF;
END;
$final$;
ROLLBACK;
