-- Disposable PostgreSQL tests: personal identity, CAS, separation and append-only history.
BEGIN;
CREATE ROLE ci_p2_checkpoint_author LOGIN;
CREATE ROLE ci_p2_checkpoint_reviewer LOGIN;
CREATE ROLE ci_p2_checkpoint_unknown LOGIN;
GRANT vns_p2_named_client TO ci_p2_checkpoint_author,
  ci_p2_checkpoint_reviewer,ci_p2_checkpoint_unknown;
INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES
('ca300001-1111-4111-8111-111111111111','ci_checkpoint_author',
 'Synthetic Checkpoint Author','editor',
 'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
('ca300002-2222-4222-8222-222222222222','ci_checkpoint_reviewer',
 'Synthetic Checkpoint Reviewer','reviewer',
 'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);
INSERT INTO vns.editor_db_principals(login_role,editor_id,auth_version,active)
VALUES('ci_p2_checkpoint_author','ca300001-1111-4111-8111-111111111111',0,true),
('ci_p2_checkpoint_reviewer','ca300002-2222-4222-8222-222222222222',0,true);
INSERT INTO vns.research_events(event_id,event_fingerprint,label)
VALUES('ca300003-3333-4333-8333-333333333333',repeat('c',64),
 'Synthetic audit event requiring external verification');

DO $test$
BEGIN
 IF has_function_privilege('vns_api_runtime',
   'vns.named_append_editorial_checkpoint(uuid,integer,text,text,text,jsonb,integer)',
   'EXECUTE')
 OR has_table_privilege('vns_p2_named_client',
   'vns.editorial_checkpoint_log','INSERT')
 OR has_function_privilege('vns_feed_poll_writer',
   'vns.named_read_editorial_checkpoints(uuid,integer,integer)','EXECUTE')
 THEN RAISE EXCEPTION 'unsafe checkpoint runtime grant'; END IF;
END $test$;

SET SESSION AUTHORIZATION ci_p2_checkpoint_author;
DO $test$
DECLARE saved boolean; denied boolean := false;
BEGIN
 SELECT vns.named_append_editorial_checkpoint(
 'ca300003-3333-4333-8333-333333333333',0,'ranking','candidate',
 repeat('a',64),'["metadata_candidate_only"]'::jsonb,55) INTO saved;
 IF saved IS DISTINCT FROM true THEN RAISE EXCEPTION 'ranking checkpoint absent'; END IF;
 SELECT vns.named_append_editorial_checkpoint(
 'ca300003-3333-4333-8333-333333333333',0,'ranking','candidate',
 repeat('a',64),'["metadata_candidate_only"]'::jsonb,55) INTO saved;
 IF saved IS DISTINCT FROM false THEN RAISE EXCEPTION 'stale checkpoint revision passed'; END IF;
 SELECT vns.named_append_editorial_checkpoint(
 'ca300003-3333-4333-8333-333333333333',1,'script_revision','needs_review',
 repeat('b',64),'["independent_verification_required"]'::jsonb,NULL) INTO saved;
 IF saved IS DISTINCT FROM true THEN RAISE EXCEPTION 'script checkpoint absent'; END IF;
 BEGIN
   PERFORM vns.named_append_editorial_checkpoint(
   'ca300003-3333-4333-8333-333333333333',2,'quality','candidate',
   repeat('d',64),'["qa_candidate"]'::jsonb,NULL);
 EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
 IF NOT denied THEN RAISE EXCEPTION 'script author self-reviewed QA'; END IF;
 denied := false;
 BEGIN
  PERFORM vns.named_read_editorial_checkpoints(
    'ca300003-3333-4333-8333-333333333333',0,20);
 EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
 IF NOT denied THEN RAISE EXCEPTION 'editor read personal reviewer export'; END IF;
END $test$;
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION ci_p2_checkpoint_reviewer;
DO $test$
DECLARE saved boolean; n integer; denied boolean := false;
BEGIN
 BEGIN
  PERFORM vns.named_append_editorial_checkpoint(
  'ca300003-3333-4333-8333-333333333333',2,'script_revision','candidate',
  repeat('c',64),'["script_replaced"]'::jsonb,NULL);
 EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
 IF NOT denied THEN RAISE EXCEPTION 'reviewer authored script'; END IF;
 SELECT vns.named_append_editorial_checkpoint(
  'ca300003-3333-4333-8333-333333333333',2,'claim_review','needs_review',
  repeat('d',64),'["claim_evidence_unverified"]'::jsonb,NULL) INTO saved;
 IF saved IS DISTINCT FROM true THEN RAISE EXCEPTION 'claim review not recorded'; END IF;
 SELECT vns.named_append_editorial_checkpoint(
  'ca300003-3333-4333-8333-333333333333',3,'quality','blocked',
  repeat('e',64),'["independent_review_required"]'::jsonb,NULL) INTO saved;
 IF saved IS DISTINCT FROM true THEN RAISE EXCEPTION 'independent QA not recorded'; END IF;
 SELECT count(*) INTO n FROM vns.named_read_editorial_checkpoints(
  'ca300003-3333-4333-8333-333333333333',2,20);
 IF n<>2 THEN RAISE EXCEPTION 'cursor export not bounded'; END IF;
END $test$;
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION ci_p2_checkpoint_unknown;
DO $test$
DECLARE denied boolean := false;
BEGIN
 BEGIN
  PERFORM vns.named_append_editorial_checkpoint(
  'ca300003-3333-4333-8333-333333333333',4,'ranking','blocked',
  repeat('f',64),'["unknown_operator"]'::jsonb,0);
 EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
 IF NOT denied THEN RAISE EXCEPTION 'unregistered login wrote checkpoint'; END IF;
END $test$;
RESET SESSION AUTHORIZATION;

DO $test$
DECLARE n integer; refused boolean := false;
BEGIN
 SELECT count(*) INTO n FROM vns.editorial_checkpoint_log
 WHERE event_id='ca300003-3333-4333-8333-333333333333';
 IF n<>4 THEN RAISE EXCEPTION 'expected four immutable checkpoints'; END IF;
 SELECT count(*) INTO n FROM vns.editorial_checkpoint_log
 WHERE event_id='ca300003-3333-4333-8333-333333333333'
   AND revision=4
   AND actor_id='ca300002-2222-4222-8222-222222222222';
 IF n<>1 THEN RAISE EXCEPTION 'reviewer not bound to DB authentication'; END IF;
 SELECT count(*) INTO n FROM vns.editorial_checkpoint_log a
 JOIN vns.editorial_checkpoint_log b ON a.event_id=b.event_id
 AND a.revision+1=b.revision
 WHERE a.chain_sha256=b.previous_sha256;
 IF n<>3 THEN RAISE EXCEPTION 'broken checkpoint chain'; END IF;
 BEGIN
  UPDATE vns.editorial_checkpoint_log SET outcome='candidate'
  WHERE event_id='ca300003-3333-4333-8333-333333333333' AND revision=4;
 EXCEPTION WHEN insufficient_privilege THEN refused := true; END;
 IF NOT refused THEN RAISE EXCEPTION 'mutable checkpoint ledger'; END IF;
END $test$;
ROLLBACK;
