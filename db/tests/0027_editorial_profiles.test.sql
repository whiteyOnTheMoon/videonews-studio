BEGIN;
DO $test$
DECLARE actor uuid; accepted boolean; denied boolean:=false;
BEGIN
 INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
 VALUES('ca270001-1111-4111-8111-111111111111','ci_profile_owner',
 'Synthetic Profile Owner','admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true)
 RETURNING id INTO actor;
 SELECT vns.commit_editorial_profiles(0,'[{"id":"science","language":"de-DE"}]'::jsonb,actor,0)
 INTO accepted;
 IF accepted IS DISTINCT FROM true THEN RAISE EXCEPTION 'profile CAS commit failed'; END IF;
 SELECT vns.commit_editorial_profiles(0,'[]'::jsonb,actor,0) INTO accepted;
 IF accepted IS DISTINCT FROM false THEN RAISE EXCEPTION 'stale profile revision accepted'; END IF;
 IF (SELECT count(*) FROM vns.editorial_profile_audit WHERE actor_id=actor)<>1
 THEN RAISE EXCEPTION 'missing atomic audit'; END IF;
 BEGIN
  PERFORM vns.commit_editorial_profiles(1,'[]'::jsonb,actor,19);
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'revoked editor auth version accepted'; END IF;
 IF has_table_privilege('vns_api_runtime','vns.editorial_profile_registry','UPDATE')
 OR has_function_privilege('vns_api_runtime',
  'vns.commit_editorial_profiles(bigint,jsonb,uuid,integer)','EXECUTE')
 THEN RAISE EXCEPTION 'profile mutation exposed to runtime'; END IF;
END $test$;
ROLLBACK;
