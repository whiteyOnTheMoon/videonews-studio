BEGIN;
DO $$
DECLARE story uuid; actor uuid; inserted uuid; blocked boolean;
BEGIN
 INSERT INTO vns.sources(name,canonical_url) VALUES
 ('Synthetic Timeline Source','https://timeline.example.org/feed')
 RETURNING id INTO story;
 INSERT INTO vns.stories(source_id,slug,title)
 VALUES(story,'synthetic-timeline-test','Synthetic Timeline Story')
 RETURNING id INTO story;
 INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
 VALUES('ca240001-1111-4111-8111-111111111111','ci_timeline_reviewer',
 'CI Timeline Reviewer','admin','scrypt
 INSERT INTO vns.editorial_timeline(story_id,event_kind,actor_id,details)
 VALUES(story,'decision',actor,'{"outcome":"offline_pending"}'::jsonb)
 RETURNING event_id INTO inserted;
 blocked:=false;
 BEGIN
  UPDATE vns.editorial_timeline SET details='{}'::jsonb WHERE event_id=inserted;
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'editorial ledger update bypass'; END IF;
 blocked:=false;
 BEGIN
  DELETE FROM vns.editorial_timeline WHERE event_id=inserted;
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'editorial ledger deletion bypass'; END IF;
 IF has_table_privilege('vns_api_runtime','vns.editorial_timeline','INSERT')
 OR has_table_privilege('vns_api_runtime','vns.editorial_timeline','UPDATE')
 THEN RAISE EXCEPTION 'runtime timeline write privileges too broad'; END IF;
END $$;
ROLLBACK;
||repeat('a',32)||'
 INSERT INTO vns.editorial_timeline(story_id,event_kind,actor_id,details)
 VALUES(story,'decision',actor,'{"outcome":"offline_pending"}'::jsonb)
 RETURNING event_id INTO inserted;
 blocked:=false;
 BEGIN
  UPDATE vns.editorial_timeline SET details='{}'::jsonb WHERE event_id=inserted;
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'editorial ledger update bypass'; END IF;
 blocked:=false;
 BEGIN
  DELETE FROM vns.editorial_timeline WHERE event_id=inserted;
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'editorial ledger deletion bypass'; END IF;
 IF has_table_privilege('vns_api_runtime','vns.editorial_timeline','INSERT')
 OR has_table_privilege('vns_api_runtime','vns.editorial_timeline','UPDATE')
 THEN RAISE EXCEPTION 'runtime timeline write privileges too broad'; END IF;
END $$;
ROLLBACK;
||repeat('b',128),true)
 RETURNING id INTO actor;
 INSERT INTO vns.editorial_timeline(story_id,event_kind,actor_id,details)
 VALUES(story,'decision',actor,'{"outcome":"offline_pending"}'::jsonb)
 RETURNING event_id INTO inserted;
 blocked:=false;
 BEGIN
  UPDATE vns.editorial_timeline SET details='{}'::jsonb WHERE event_id=inserted;
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'editorial ledger update bypass'; END IF;
 blocked:=false;
 BEGIN
  DELETE FROM vns.editorial_timeline WHERE event_id=inserted;
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'editorial ledger deletion bypass'; END IF;
 IF has_table_privilege('vns_api_runtime','vns.editorial_timeline','INSERT')
 OR has_table_privilege('vns_api_runtime','vns.editorial_timeline','UPDATE')
 THEN RAISE EXCEPTION 'runtime timeline write privileges too broad'; END IF;
END $$;
ROLLBACK;
