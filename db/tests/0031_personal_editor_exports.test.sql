BEGIN;
DO $test$
DECLARE denied boolean := false;
BEGIN
  IF has_function_privilege('vns_api_runtime',
    'vns.named_current_editor()','EXECUTE')
  OR has_function_privilege('vns_api_runtime',
    'vns.named_timeline_page(uuid,timestamptz,uuid,integer)','EXECUTE')
  OR has_table_privilege('vns_p2_named_client',
    'vns.editorial_timeline','SELECT')
  THEN RAISE EXCEPTION 'raw runtime export privileges are forbidden'; END IF;
  BEGIN
    PERFORM * FROM vns.named_current_editor();
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'unenrolled database session accepted'; END IF;
  denied := false;
  BEGIN
    PERFORM * FROM vns.named_timeline_page(
      '11111111-1111-4111-8111-111111111111',NULL,NULL,10);
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'unenrolled timeline export accepted'; END IF;
END $test$;
ROLLBACK;
