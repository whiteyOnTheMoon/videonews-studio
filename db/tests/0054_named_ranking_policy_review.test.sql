-- P2-04: actual PostgreSQL personal LOGIN, serial CAS, immutable reviews.
BEGIN;
INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES
('fa540001-1111-4111-8111-111111111111','ci_ranking_editor',
 'CI individually attributed ranking reviewer','admin',
 'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
('fa540002-2222-4222-8222-222222222222','ci_ranking_inactive',
 'CI inactive reviewer','admin',
 'scrypt$'||repeat('a',32)||'$'||repeat('b',128),false);
UPDATE vns.editorial_profile_registry
SET revision=1,profiles='[{"id":"science_news","language":"en-US",
"keywords":["science"],"blockedTerms":[],
"minIndependentSources":2,"maximumArticleAgeHours":24,"format":"briefing"}]'::jsonb
WHERE singleton=true;

CREATE ROLE editor_ci_ranking_named LOGIN INHERIT;
CREATE ROLE editor_ci_ranking_inactive LOGIN INHERIT;
GRANT vns_p2_named_client TO editor_ci_ranking_named,editor_ci_ranking_inactive;
INSERT INTO vns.editor_db_principals(login_role,editor_id,auth_version,active)
VALUES
('editor_ci_ranking_named','fa540001-1111-4111-8111-111111111111',0,true),
('editor_ci_ranking_inactive','fa540002-2222-4222-8222-222222222222',0,true);
DO $privileges$
BEGIN
 IF has_table_privilege('vns_p2_named_client',
       'vns.feed_ranking_policy_reviews','INSERT')
  OR has_table_privilege('vns_api_runtime',
       'vns.feed_ranking_policy_reviews','INSERT')
  OR has_table_privilege('vns_feed_project_client',
       'vns.feed_ranking_policy_reviews','INSERT')
  OR NOT has_function_privilege('vns_p2_named_client',
       'vns.named_ranking_policy_commit(text,bigint,jsonb)','EXECUTE')
 THEN RAISE EXCEPTION 'Named ranking policy privileges unsafe'; END IF;
END $privileges$;

SET SESSION AUTHORIZATION editor_ci_ranking_named;
DO $named$
DECLARE
 settings jsonb := '{"minimumPublisherGroups":2,"relevanceWeight":10,
 "freshnessWeight":20,"qualityWeight":15,"explanatoryWeight":5,
 "visualizabilityWeight":30,"riskWeight":20,"maximumRisk":3}'::jsonb;
 rev bigint;
 payload jsonb;
 success boolean;
 rejected boolean;
BEGIN
 SELECT x.policy_revision,x.settings INTO rev,payload
 FROM vns.named_ranking_policy_read('science_news') AS x;
 IF rev<>0 OR payload IS NOT NULL
 THEN RAISE EXCEPTION 'No policy must mean no reviewed settings'; END IF;
 success:=vns.named_ranking_policy_commit('science_news',0,settings);
 IF NOT success THEN RAISE EXCEPTION 'Named ranking review insert failed'; END IF;
 SELECT x.policy_revision,x.settings INTO rev,payload
 FROM vns.named_ranking_policy_read('science_news') AS x;
 IF rev<>1 OR payload IS DISTINCT FROM settings
 THEN RAISE EXCEPTION 'Review is not personally readable'; END IF;
 IF vns.named_ranking_policy_commit('science_news',0,settings)
 THEN RAISE EXCEPTION 'Stale policy CAS succeeded'; END IF;
 rejected:=false;
 BEGIN
  PERFORM vns.named_ranking_policy_commit('science_news',1,
    settings||'{"riskWeight":101}'::jsonb);
 EXCEPTION WHEN invalid_parameter_value THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Out-of-range risk accepted'; END IF;
 rejected:=false;
 BEGIN
  PERFORM vns.named_ranking_policy_commit('science_news',1,
    settings||'{"reviewerId":"fa540002-2222-4222-8222-222222222222"}'::jsonb);
 EXCEPTION WHEN invalid_parameter_value THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Forged actor field accepted'; END IF;
 rejected:=false;
 BEGIN
  INSERT INTO vns.feed_ranking_policy_reviews(
    profile_id,profile_revision,revision,minimum_publisher_groups,
    relevance_weight,freshness_weight,quality_weight,explanatory_weight,
    visualizability_weight,risk_weight,maximum_risk,reviewer_id)
  VALUES('science_news',1,99,2,10,20,15,5,30,20,3,
    'fa540001-1111-4111-8111-111111111111');
 EXCEPTION WHEN insufficient_privilege THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Direct client insert unexpectedly succeeded'; END IF;
 IF NOT vns.named_ranking_policy_commit('science_news',1,
    settings||'{"riskWeight":25}'::jsonb)
 THEN RAISE EXCEPTION 'Expected consecutive policy revision refused'; END IF;
END $named$;
RESET SESSION AUTHORIZATION;

DO $provenance$
BEGIN
 IF (SELECT count(*) FROM vns.feed_ranking_policy_reviews
     WHERE reviewer_id='fa540001-1111-4111-8111-111111111111')<>2
 OR EXISTS (SELECT 1 FROM vns.feed_ranking_policy_reviews
            WHERE profile_id='science_news' AND profile_revision<>1)
 THEN RAISE EXCEPTION 'Reviewer provenance not personally bound'; END IF;
END $provenance$;

SET SESSION AUTHORIZATION editor_ci_ranking_inactive;
DO $reject$
DECLARE denied boolean:=false;
BEGIN
 BEGIN PERFORM vns.named_ranking_policy_read('science_news');
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Inactive editor read accepted'; END IF;
END $reject$;
RESET SESSION AUTHORIZATION;
-- Auth version changes invalidate already enrolled login.
UPDATE vns.editor_accounts SET auth_version=auth_version+1
WHERE id='fa540001-1111-4111-8111-111111111111';
SET SESSION AUTHORIZATION editor_ci_ranking_named;
DO $revoked$
DECLARE denied boolean:=false;
BEGIN
 BEGIN PERFORM vns.named_ranking_policy_commit(
  'science_news',2,'{"minimumPublisherGroups":2,"relevanceWeight":10,
 "freshnessWeight":20,"qualityWeight":15,"explanatoryWeight":5,
 "visualizabilityWeight":30,"riskWeight":20,"maximumRisk":3}'::jsonb);
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Revoked personal login committed review'; END IF;
END $revoked$;
RESET SESSION AUTHORIZATION;
ROLLBACK;
