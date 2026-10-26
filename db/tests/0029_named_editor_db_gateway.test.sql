-- Real isolated PostgreSQL identity and permission tests, transactional fixture.
BEGIN;
CREATE ROLE ci_p2_db_admin LOGIN;
CREATE ROLE ci_p2_db_reviewer LOGIN;
CREATE ROLE ci_p2_db_unknown LOGIN;
GRANT vns_p2_named_client TO ci_p2_db_admin,ci_p2_db_reviewer,ci_p2_db_unknown;
INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES
('ca290001-1111-4111-8111-111111111111','ci_p2_admin','CI P2 Admin',
 'admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
('ca290002-2222-4222-8222-222222222222','ci_p2_reviewer','CI P2 Reviewer',
 'reviewer','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);
INSERT INTO vns.editor_db_principals(login_role,editor_id,auth_version,active)
VALUES
('ci_p2_db_admin','ca290001-1111-4111-8111-111111111111',0,true),
('ci_p2_db_reviewer','ca290002-2222-4222-8222-222222222222',0,true);
INSERT INTO vns.sources(name,canonical_url)
VALUES('CI P2 named gateway source','https://named-gateway.example.org/feed');
INSERT INTO vns.stories(id,source_id,slug,title)
VALUES('ca290003-3333-4333-8333-333333333333',
 (SELECT id FROM vns.sources WHERE canonical_url='https://named-gateway.example.org/feed'),
 'ci-named-p2-timeline','Named personal timeline fixture');

DO $test$
BEGIN
 IF has_function_privilege('vns_api_runtime','vns.named_profile_commit(bigint,jsonb)','EXECUTE')
 OR has_function_privilege('vns_api_runtime','vns.named_timeline_append(uuid,text,text,text,jsonb)','EXECUTE')
 OR has_function_privilege('vns_feed_poll_writer','vns.named_profile_commit(bigint,jsonb)','EXECUTE')
 OR has_table_privilege('vns_p2_named_client','vns.editor_db_principals','INSERT')
 OR has_table_privilege('vns_p2_named_client','vns.editorial_profile_audit','INSERT')
 THEN RAISE EXCEPTION 'untrusted runtime/grant boundary'; END IF;
 IF (SELECT count(*) FROM vns.editor_db_principals) <> 2
 THEN RAISE EXCEPTION 'unexpected principal population'; END IF;
END $test$;

SET SESSION AUTHORIZATION ci_p2_db_admin;
DO $test$
DECLARE saved boolean; rows_count integer; event uuid;
BEGIN
 SELECT vns.named_profile_commit(0,'[{"id":"science","language":"de-DE"}]'::jsonb)
   INTO saved;
 IF saved IS DISTINCT FROM true THEN RAISE EXCEPTION 'admin CAS not saved'; END IF;
 SELECT vns.named_profile_commit(0,'[]'::jsonb) INTO saved;
 IF saved IS DISTINCT FROM false THEN RAISE EXCEPTION 'stale revision bypassed'; END IF;
 SELECT count(*) INTO rows_count FROM vns.named_profile_read();
 IF rows_count<>1 THEN RAISE EXCEPTION 'named profile reader failed'; END IF;
 event := vns.named_timeline_append(
  'ca290003-3333-4333-8333-333333333333','decision',NULL,NULL,
  '{"outcome":"offline_pending"}'::jsonb);
 IF event IS NULL THEN RAISE EXCEPTION 'named append failed'; END IF;
 SELECT count(*) INTO rows_count FROM
   vns.named_timeline_read('ca290003-3333-4333-8333-333333333333',10);
 IF rows_count<>1 THEN RAISE EXCEPTION 'named read failed'; END IF;
END $test$;
-- Even changing current_user to the shared access role does not change session_user.
SET ROLE vns_p2_named_client;
DO $test$
DECLARE cnt integer;
BEGIN
 IF session_user <> 'ci_p2_db_admin' THEN RAISE EXCEPTION 'session identity replaced'; END IF;
 SELECT count(*) INTO cnt FROM vns.named_profile_read();
 IF cnt<>1 THEN RAISE EXCEPTION 'SET ROLE changed personal login'; END IF;
END $test$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION ci_p2_db_reviewer;
DO $test$
DECLARE blocked boolean := false; cnt integer; event uuid;
BEGIN
 BEGIN
   PERFORM vns.named_profile_commit(1,'[]'::jsonb);
 EXCEPTION WHEN insufficient_privilege THEN blocked := true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'reviewer edited admin profiles'; END IF;
 blocked := false;
 BEGIN
   PERFORM * FROM vns.named_profile_read();
 EXCEPTION WHEN insufficient_privilege THEN blocked := true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'reviewer read admin profiles'; END IF;
 SELECT count(*) INTO cnt FROM
   vns.named_timeline_read('ca290003-3333-4333-8333-333333333333',10);
 IF cnt<>1 THEN RAISE EXCEPTION 'reviewer cannot read timeline'; END IF;
 event := vns.named_timeline_append(
   'ca290003-3333-4333-8333-333333333333',
   'review',NULL,NULL,'{"state":"needs_evidence"}'::jsonb);
 IF event IS NULL THEN RAISE EXCEPTION 'reviewer cannot append'; END IF;
END $test$;
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION ci_p2_db_unknown;
DO $test$
DECLARE blocked boolean := false;
BEGIN
 BEGIN
   PERFORM vns.named_profile_commit(1,'[]'::jsonb);
 EXCEPTION WHEN insufficient_privilege THEN blocked := true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'unregistered login edited profile'; END IF;
 blocked := false;
 BEGIN
   PERFORM vns.named_timeline_append(
     'ca290003-3333-4333-8333-333333333333',
     'decision',NULL,NULL,'{}'::jsonb);
 EXCEPTION WHEN insufficient_privilege THEN blocked := true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'unregistered login wrote ledger'; END IF;
END $test$;
RESET SESSION AUTHORIZATION;

-- Only a privileged DBA can revoke the personal enrollment.
UPDATE vns.editor_db_principals SET active=false
  WHERE login_role='ci_p2_db_admin';
SET SESSION AUTHORIZATION ci_p2_db_admin;
DO $test$
DECLARE blocked boolean := false;
BEGIN
 BEGIN
   PERFORM * FROM vns.named_profile_read();
 EXCEPTION WHEN insufficient_privilege THEN blocked := true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'revoked admin login still authorized'; END IF;
END $test$;
RESET SESSION AUTHORIZATION;

DO $test$
DECLARE cnt integer;
BEGIN
 SELECT count(*) INTO cnt FROM vns.editorial_profile_audit
 WHERE actor_id='ca290001-1111-4111-8111-111111111111';
 IF cnt<>1 THEN RAISE EXCEPTION 'named audit identity not durable'; END IF;
 SELECT count(*) INTO cnt FROM vns.editorial_timeline
 WHERE story_id='ca290003-3333-4333-8333-333333333333'
   AND actor_id='ca290002-2222-4222-8222-222222222222'
   AND event_kind='review';
 IF cnt<>1 THEN RAISE EXCEPTION 'reviewer ledger actor not durable'; END IF;
END $test$;
ROLLBACK;
