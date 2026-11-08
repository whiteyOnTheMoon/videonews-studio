-- Disposable CI fixture only: source, host and editor are entirely synthetic.
BEGIN;
CREATE ROLE ci_inbox_admin LOGIN INHERIT;
CREATE ROLE ci_inbox_reviewer LOGIN INHERIT;
CREATE ROLE ci_inbox_unknown LOGIN INHERIT;
GRANT vns_p2_named_client TO ci_inbox_admin,ci_inbox_reviewer,ci_inbox_unknown;

INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES
('fa630001-1111-4111-8111-111111111111','ci_inbox_admin',
 'Synthetic administrator','admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
('fa630002-2222-4222-8222-222222222222','ci_inbox_reviewer',
 'Synthetic reviewer','reviewer','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);
INSERT INTO vns.editor_db_principals(login_role,editor_id,auth_version,active)
VALUES
('ci_inbox_admin','fa630001-1111-4111-8111-111111111111',0,true),
('ci_inbox_reviewer','fa630002-2222-4222-8222-222222222222',0,true);

-- Synthetic feed authorization is seeded directly ONLY by CI superuser.
UPDATE vns.admin_source_registry SET revision=10,
 sources=jsonb_build_array(jsonb_build_object(
 'id','ci_inbox_news','baseUrl','https://inbox.example.org/news/',
 'termsUrl','https://inbox.example.org/terms/','access','rss',
 'intervalMinutes',60,'usage','metadata_only',
 'licenseNotes','Fake CI-only metadata with no licensing authority.',
 'status','approved','reviewedAt','2026-11-08')) WHERE singleton;
UPDATE vns.admin_source_host_approvals SET revision=10,
 approved_hosts='["inbox.example.org"]'::jsonb WHERE singleton;
INSERT INTO vns.admin_source_host_audit(
 revision,source_revision,action,host,reason,editor_id,
 editor_username,editor_auth_version)
VALUES(10,10,'grant','inbox.example.org',
 'CI-only synthetic host approval, never real authorization.',
 'fa630001-1111-4111-8111-111111111111','ci_inbox_admin',0);

INSERT INTO vns.feed_poll_state(source_id,next_eligible_at,lease_token)
VALUES('ci_inbox_news',clock_timestamp()+interval '1 hour',
 'fa630003-3333-4333-8333-333333333333');
INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES
('ci_inbox_news','https://inbox.example.org/news/unmapped',
 'Synthetic event waiting for projection',clock_timestamp()-interval '4 days'),
('ci_inbox_news','https://inbox.example.org/news/mapped',
 'Synthetic event already mapped to research',clock_timestamp()-interval '4 days');
INSERT INTO vns.research_articles(source_key,canonical_url,headline,headline_sha256,published_at)
SELECT source_id,article_url,headline,repeat('a',64),published_at
FROM vns.feed_poll_candidates WHERE article_url LIKE '%/mapped';
INSERT INTO vns.research_events(event_fingerprint,label)
VALUES(repeat('b',64),'Synthetic event already mapped to research');
INSERT INTO vns.research_event_articles(event_id,article_id)
SELECT e.event_id,a.article_id FROM vns.research_events e
CROSS JOIN vns.research_articles a
WHERE e.event_fingerprint=repeat('b',64)
  AND a.canonical_url='https://inbox.example.org/news/mapped';

DO $privileges$
BEGIN
 IF has_table_privilege('vns_p2_named_client','vns.feed_poll_candidates','SELECT')
   OR has_table_privilege('vns_api_runtime','vns.feed_poll_candidates','SELECT')
   OR has_function_privilege('vns_feed_poll_writer',
       'vns.named_feed_inbox_page(integer)','EXECUTE')
   OR NOT has_function_privilege('ci_inbox_admin',
       'vns.named_feed_inbox_page(integer)','EXECUTE')
 THEN RAISE EXCEPTION 'Inbox privileges expanded'; END IF;
END $privileges$;

SET SESSION AUTHORIZATION ci_inbox_admin;
DO $read$
DECLARE n integer; mapped integer; unmapped integer; refused boolean:=false;
BEGIN
 SELECT count(*),count(*) FILTER (WHERE projected AND event_id IS NOT NULL),
    count(*) FILTER (WHERE NOT projected AND event_id IS NULL)
 INTO n,mapped,unmapped FROM vns.named_feed_inbox_page(25);
 IF n<>2 OR mapped<>1 OR unmapped<>1
 THEN RAISE EXCEPTION 'Projected and unmapped inbox metadata missing'; END IF;
 IF EXISTS (SELECT 1 FROM vns.named_feed_inbox_page(25)
   WHERE approved_for_publication
     OR published_at>clock_timestamp()-interval '3 days'
     OR source_id<>'ci_inbox_news')
 THEN RAISE EXCEPTION 'Inbox freshness or publication forged'; END IF;
 BEGIN
   PERFORM * FROM vns.named_feed_inbox_page(26);
 EXCEPTION WHEN invalid_parameter_value THEN refused:=true;
 END;
 IF NOT refused THEN RAISE EXCEPTION 'Limit 26 unexpectedly accepted'; END IF;
END $read$;
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION ci_inbox_reviewer;
DO $reject$
DECLARE refused boolean:=false;
BEGIN
 BEGIN PERFORM * FROM vns.named_feed_inbox_page(25);
 EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
 IF NOT refused THEN RAISE EXCEPTION 'Reviewer viewed Admin inbox'; END IF;
END $reject$;
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION ci_inbox_unknown;
DO $reject$
DECLARE refused boolean:=false;
BEGIN
 BEGIN PERFORM * FROM vns.named_feed_inbox_page(25);
 EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
 IF NOT refused THEN RAISE EXCEPTION 'Unknown login viewed Admin inbox'; END IF;
END $reject$;
RESET SESSION AUTHORIZATION;

UPDATE vns.admin_source_host_approvals SET approved_hosts='[]'::jsonb WHERE singleton;
SET SESSION AUTHORIZATION ci_inbox_admin;
DO $revoked$
BEGIN
 IF EXISTS (SELECT 1 FROM vns.named_feed_inbox_page(25))
 THEN RAISE EXCEPTION 'Revoked host remained visible'; END IF;
END $revoked$;
RESET SESSION AUTHORIZATION;
UPDATE vns.admin_source_host_approvals
 SET approved_hosts='["inbox.example.org"]'::jsonb WHERE singleton;
UPDATE vns.editor_db_principals SET active=false WHERE login_role='ci_inbox_admin';
SET SESSION AUTHORIZATION ci_inbox_admin;
DO $revoked$
DECLARE refused boolean:=false;
BEGIN
 BEGIN PERFORM * FROM vns.named_feed_inbox_page(25);
 EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
 IF NOT refused THEN RAISE EXCEPTION 'Revoked editor viewed Admin inbox'; END IF;
END $revoked$;
RESET SESSION AUTHORIZATION;
ROLLBACK;
