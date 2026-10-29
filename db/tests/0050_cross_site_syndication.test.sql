-- P2-03: real published NASA/JPL cross-site headline used as an OFFLINE
-- metadata-only fixture. No external feed request or real-source approval.
BEGIN;
INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
VALUES
('fa520001-1111-4111-8111-111111111111','ci_synd_source',
 'Synthetic syndication source reviewer','admin',
 'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
('fa520002-2222-4222-8222-222222222222','ci_synd_host',
 'Synthetic syndication host reviewer','admin',
 'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true);

SET LOCAL ROLE vns_source_admin_writer;
DO $sources$
DECLARE
  old_rev bigint;
  existing jsonb;
  entry jsonb;
  at_time timestamptz := clock_timestamp();
  candidate record;
BEGIN
  SELECT revision,sources INTO old_rev,existing
    FROM vns.admin_source_registry WHERE singleton=true;
  FOR candidate IN
    SELECT * FROM (VALUES
      ('ci_jpl_syndicated','https://www.jpl.nasa.gov/news/',
       'https://www.jpl.nasa.gov/feeds/news/','https://www.jpl.nasa.gov/rss/'),
      ('ci_nasa_syndicated',
       'https://science.nasa.gov/blogs/perseverance-mars-rover/',
       'https://science.nasa.gov/blogs/perseverance-mars-rover/',
       'https://science.nasa.gov/')
    ) AS s(id,article_scope,endpoint,terms)
  LOOP
    entry:=jsonb_build_object(
      'id',candidate.id,'baseUrl',candidate.article_scope,
      'access','rss','intervalMinutes',60,'termsUrl',candidate.terms,
      'usage','metadata_only','licenseNotes',
      'CI-only metadata fixture; no live authorization.',
      'status','pending','reviewedAt',to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD')
    );
    IF candidate.id='ci_jpl_syndicated' THEN
      entry:=entry||jsonb_build_object('feedUrl',candidate.endpoint);
    END IF;
    IF NOT vns.admin_commit_source_registry(old_rev,old_rev+1,
       existing||jsonb_build_array(entry),candidate.id,'create_pending',
       'fa520001-1111-4111-8111-111111111111',0,at_time)
    THEN RAISE EXCEPTION 'Synthetic source registration denied'; END IF;
    old_rev:=old_rev+1;
    existing:=existing||jsonb_build_array(entry);
    entry:=jsonb_set(entry,'{status}','"approved"'::jsonb);
    IF NOT vns.admin_commit_source_registry(old_rev,old_rev+1,
       (SELECT jsonb_agg(CASE WHEN x.value->>'id'=candidate.id
                            THEN entry ELSE x.value END ORDER BY x.value->>'id')
        FROM jsonb_array_elements(existing) AS x(value)),
       candidate.id,'approve','fa520001-1111-4111-8111-111111111111',0,at_time)
    THEN RAISE EXCEPTION 'Synthetic source review denied'; END IF;
    old_rev:=old_rev+1;
    SELECT sources INTO existing
      FROM vns.admin_source_registry WHERE singleton=true;
  END LOOP;
  PERFORM set_config('vns.ci_synd_source_revision',old_rev::text,true);
END $sources$;
RESET ROLE;

SET LOCAL ROLE vns_host_approval_writer;
DO $hosts$
DECLARE old_rev bigint;src_rev bigint;
BEGIN
  SELECT revision INTO old_rev
    FROM vns.admin_source_host_approvals WHERE singleton=true;
  src_rev:=current_setting('vns.ci_synd_source_revision')::bigint;
  IF NOT vns.admin_change_source_host_approval(old_rev,src_rev,'grant',
       'www.jpl.nasa.gov','Synthetic independent host grant for metadata-only CI.',
       'fa520002-2222-4222-8222-222222222222',0)
  THEN RAISE EXCEPTION 'JPL host fixture refused'; END IF;
  IF NOT vns.admin_change_source_host_approval(old_rev+1,src_rev,'grant',
       'science.nasa.gov','Synthetic independent host grant for metadata-only CI.',
       'fa520002-2222-4222-8222-222222222222',0)
  THEN RAISE EXCEPTION 'NASA host fixture refused'; END IF;
END $hosts$;
RESET ROLE;

UPDATE vns.editorial_profile_registry
SET revision=1,
 profiles='[{"id":"nasa_news","language":"en-US","keywords":["Perseverance"],
 "blockedTerms":[],"minIndependentSources":2,
 "maximumArticleAgeHours":720,"format":"briefing"}]'::jsonb
WHERE singleton=true;

INSERT INTO vns.feed_poll_state(source_id,next_eligible_at,lease_token)
VALUES
('ci_jpl_syndicated',clock_timestamp()+interval '1 hour',
 'fa520000-3333-4333-8333-333333333333'),
('ci_nasa_syndicated',clock_timestamp()+interval '1 hour',
 'fa520000-3333-4333-8333-444444444444');
INSERT INTO vns.feed_poll_candidates(source_id,article_url,headline,published_at)
VALUES
('ci_jpl_syndicated',
 'https://www.jpl.nasa.gov/news/nasas-perseverance-sets-off-world-record-for-total-distance-driven/',
 'NASA’s Perseverance Sets Off-World Record for Total Distance Driven',
 clock_timestamp()-interval '2 hours'),
('ci_nasa_syndicated',
 'https://science.nasa.gov/blogs/perseverance-mars-rover/2026/10/12/nasas-perseverance-sets-off-world-record-for-total-distance-driven/',
 'NASA’s Perseverance Sets Off-World Record for Total Distance Driven',
 clock_timestamp()-interval '2 hours');
SET LOCAL ROLE vns_feed_project_client;
DO $project$
DECLARE projected integer;
BEGIN
  SELECT vns.project_approved_feed_candidates('ci_jpl_syndicated',5)
    INTO projected;
  IF projected<>1 THEN RAISE EXCEPTION 'First syndication fixture missing'; END IF;
  SELECT vns.project_approved_feed_candidates('ci_nasa_syndicated',5)
    INTO projected;
  IF projected<>1 THEN RAISE EXCEPTION 'Second syndication fixture missing'; END IF;
  SELECT vns.project_approved_feed_candidates('ci_nasa_syndicated',5)
    INTO projected;
  IF projected<>0 THEN RAISE EXCEPTION 'Syndication replay created duplicate'; END IF;
END $project$;
RESET ROLE;
DO $assert$
BEGIN
  IF (SELECT count(*) FROM vns.research_events)<>1
     OR (SELECT count(*) FROM vns.research_articles)<>2
     OR (SELECT count(*) FROM vns.research_event_articles)<>2
     OR (SELECT count(*) FROM vns.feed_event_rankings
         WHERE profile_id='nasa_news')<>1
     OR EXISTS (SELECT 1 FROM vns.feed_event_rankings
                WHERE profile_id='nasa_news'
                AND (source_count<>2 OR article_count<>2
                     OR approved_for_publication<>false
                     OR NOT reasons ? 'independent_verification_required'))
  THEN RAISE EXCEPTION 'Cross-site syndicated article identity or ranking invalid'; END IF;
END $assert$;
-- IMPORTANT: two source IDs here still belong to ONE NASA publisher group.
-- This fixture verifies exact-title PostgreSQL event deduplication, NOT
-- independent publisher provenance or rewritten-title semantic deduplication.
ROLLBACK;
