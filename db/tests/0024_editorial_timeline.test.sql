BEGIN;
DO $$
DECLARE story uuid; actor uuid; inserted uuid; blocked boolean;
BEGIN
 SELECT id INTO story FROM vns.stories LIMIT 1;
 SELECT id INTO actor FROM vns.editor_accounts LIMIT 1;
 IF story IS NULL OR actor IS NULL THEN
  RAISE EXCEPTION 'editorial fixture not available';
 END IF;
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
