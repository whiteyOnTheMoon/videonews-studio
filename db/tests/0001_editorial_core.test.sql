-- Tests always run in an ephemeral GitHub Actions Postgres container.
BEGIN;
DO $tests$
DECLARE
  src uuid; st uuid; lic uuid; scr uuid; job uuid; vid uuid;
  before_update timestamptz; after_update timestamptz; count_tables integer;
BEGIN
  SELECT count(*) INTO count_tables FROM pg_catalog.pg_tables
    WHERE schemaname = 'vns' AND tablename = ANY(ARRAY[
      'schema_migrations','sources','licenses','stories','claims','assets',
      'scripts','jobs','videos','costs','approvals','uploads'
    ]);
  IF count_tables <> 12 OR NOT EXISTS (
    SELECT 1 FROM vns.schema_migrations WHERE version='0001_editorial_core'
  ) THEN RAISE EXCEPTION 'schema or ledger not complete'; END IF;

  INSERT INTO vns.sources(name,canonical_url) VALUES
    ('Test source','https://example.invalid/source') RETURNING id INTO src;
  INSERT INTO vns.licenses(code,name) VALUES
    ('TEST-LICENSE','Test permission') RETURNING id INTO lic;
  INSERT INTO vns.stories(source_id,slug,title) VALUES
    (src,'example-story','Example') RETURNING id,updated_at INTO st,before_update;
  UPDATE vns.stories SET title='Edited' WHERE id=st RETURNING updated_at INTO after_update;
  IF after_update <= before_update THEN RAISE EXCEPTION 'updated_at trigger broken'; END IF;

  INSERT INTO vns.claims(story_id,source_id,statement,evidence_url,verification_status,verified_at)
    VALUES(st,src,'Test claim','https://example.invalid/evidence','verified',now());
  BEGIN
    INSERT INTO vns.claims(story_id,source_id,statement,evidence_url,verification_status)
      VALUES(st,src,'Unverified date','https://example.invalid/evidence','verified');
    RAISE EXCEPTION 'verified claim without date allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO vns.assets(story_id,license_id,kind,storage_key,rights_status,rights_verified_at)
    VALUES(st,lic,'image','tests/cleared-image','cleared',now());
  BEGIN
    INSERT INTO vns.assets(story_id,kind,storage_key,rights_status)
      VALUES(st,'image','tests/no-rights','cleared');
    RAISE EXCEPTION 'asset cleared without license allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO vns.scripts(story_id,version,body) VALUES(st,1,'Test manuscript') RETURNING id INTO scr;
  BEGIN
    INSERT INTO vns.scripts(story_id,version,body) VALUES(st,1,'Duplicate');
    RAISE EXCEPTION 'duplicate script version allowed';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  INSERT INTO vns.jobs(story_id,kind,idempotency_key)
    VALUES(st,'render','test-render-1') RETURNING id INTO job;
  BEGIN
    INSERT INTO vns.jobs(kind,idempotency_key) VALUES('render','test-render-1');
    RAISE EXCEPTION 'duplicate idempotency key allowed';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO vns.jobs(kind,attempt_count,max_attempts) VALUES('render',5,3);
    RAISE EXCEPTION 'excessive retries allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO vns.videos(script_id,render_job_id) VALUES(scr,job) RETURNING id INTO vid;
  INSERT INTO vns.approvals(video_id,reviewer,decision) VALUES(vid,'human-reviewer','approved');
  INSERT INTO vns.uploads(video_id,platform) VALUES(vid,'example');
  BEGIN
    INSERT INTO vns.uploads(video_id,platform,status) VALUES(vid,'example','published');
    RAISE EXCEPTION 'upload without external id allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO vns.uploads(video_id,platform,status,external_id,completed_at)
    VALUES(vid,'example','published','external-123',now());
  BEGIN
    INSERT INTO vns.uploads(video_id,platform,external_id) VALUES(vid,'example','external-123');
    RAISE EXCEPTION 'duplicate external id allowed';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  INSERT INTO vns.costs(job_id,provider,metric,quantity,amount)
    VALUES(job,'test-provider','tokens',100,0.003);
  BEGIN
    INSERT INTO vns.costs(provider,metric,amount) VALUES('example','tokens',-0.5);
    RAISE EXCEPTION 'negative cost allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO vns.stories(source_id,slug,title) VALUES(src,'example-story','Duplicate');
    RAISE EXCEPTION 'duplicate story slug allowed';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    DELETE FROM vns.sources WHERE id=src;
    RAISE EXCEPTION 'referenced source deletion allowed';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END;
$tests$;
ROLLBACK;
