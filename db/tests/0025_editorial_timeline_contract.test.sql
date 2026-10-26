BEGIN;
DO $test$
DECLARE v_source uuid; v_story uuid; v_editor uuid; v_reviewer uuid; v_event uuid; v_count integer; denied boolean;
BEGIN
 INSERT INTO vns.sources(name,canonical_url)
 VALUES('Synthetic Timeline Contract','https://contract.example.org/feed')
 RETURNING id INTO v_source;
 INSERT INTO vns.stories(source_id,slug,title)
 VALUES(v_source,'timeline-contract-ci','Timeline contract test')
 RETURNING id INTO v_story;
 INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
 VALUES('ca250001-1111-4111-8111-111111111111','ci_timeline_writer',
 'Synthetic Timeline Writer','editor','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true)
 RETURNING id INTO v_editor;
 INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
 VALUES('ca250002-2222-4222-8222-222222222222','ci_timeline_reader',
 'Synthetic Timeline Reader','reviewer','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true)
 RETURNING id INTO v_reviewer;
 v_event:=vns.append_editorial_timeline(v_story,'decision',v_editor,0,NULL,NULL,'{"state":"pending"}'::jsonb);
 IF v_event IS NULL THEN RAISE EXCEPTION 'append failed'; END IF;
 SELECT count(*) INTO v_count FROM vns.read_editorial_timeline(v_story,v_reviewer,0,10);
 IF v_count<>1 THEN RAISE EXCEPTION 'timeline query missing event'; END IF;
 denied:=false;
 BEGIN
  PERFORM * FROM vns.read_editorial_timeline(v_story,v_editor,0,10);
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'editor read not denied'; END IF;
 denied:=false;
 BEGIN
  PERFORM vns.append_editorial_timeline(v_story,'decision',v_editor,99,NULL,NULL,'{}'::jsonb);
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'revoked version accepted'; END IF;
 IF has_function_privilege('vns_api_runtime',
   'vns.append_editorial_timeline(uuid,text,uuid,integer,text,text,jsonb)','EXECUTE')
 OR has_function_privilege('vns_api_runtime',
   'vns.read_editorial_timeline(uuid,uuid,integer,integer)','EXECUTE')
 THEN RAISE EXCEPTION 'unsafe runtime timeline grants'; END IF;
END $test$;
ROLLBACK;
