-- CI-only: verify restored relational state and protections, then roll back checks.
BEGIN;

DO $verify$
DECLARE
  table_name text;
  row_total bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vns.schema_migrations WHERE version = '0001_editorial_core'
  ) THEN RAISE EXCEPTION 'migration ledger absent after restore'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM vns.schema_migrations WHERE version = '0002_job_outbox'
  ) THEN RAISE EXCEPTION 'outbox migration ledger absent after restore'; END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'schema_migrations', 'sources', 'licenses', 'stories', 'claims',
    'assets', 'scripts', 'jobs', 'job_outbox', 'videos', 'costs', 'approvals', 'uploads'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM vns.%I', table_name) INTO row_total;
    IF row_total <> (CASE WHEN table_name = 'schema_migrations' THEN 2 ELSE 1 END) THEN
      RAISE EXCEPTION 'restored table % has % rows rather than 1', table_name, row_total;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM vns.stories st
      JOIN vns.sources src ON src.id = st.source_id
      JOIN vns.claims cl ON cl.story_id = st.id AND cl.source_id = src.id
      JOIN vns.assets ast ON ast.story_id = st.id AND ast.source_id = src.id
      JOIN vns.licenses lic ON lic.id = ast.license_id
      JOIN vns.scripts sc ON sc.story_id = st.id
      JOIN vns.videos vid ON vid.script_id = sc.id
      JOIN vns.jobs j ON j.id = vid.render_job_id AND j.story_id = st.id
      JOIN vns.job_outbox ob ON ob.job_id = j.id
      JOIN vns.costs c ON c.job_id = j.id
      JOIN vns.approvals ap ON ap.video_id = vid.id
      JOIN vns.uploads up ON up.video_id = vid.id
    WHERE src.canonical_url = 'https://example.invalid/restore-source'
      AND st.slug = 'restore-fixture-story' AND st.status = 'review'
      AND cl.verification_status = 'verified' AND cl.verified_at IS NOT NULL
      AND lic.code = 'CI-RESTORE' AND ast.rights_status = 'cleared'
      AND sc.status = 'approved' AND sc.body = 'Fixture script text'
      AND ob.queue_job_id = 'job-' || replace(j.id::text, '-', '')
      AND ob.delivery_state = 'enqueued' AND ob.dispatch_attempts = 1
      AND ob.enqueued_at IS NOT NULL
      AND j.idempotency_key = 'ci-restore-job' AND j.attempt_count = 1
      AND j.max_attempts = 3 AND j.status = 'retry'
      AND vid.duration_ms = 42000 AND vid.storage_key = 'ci/restore-video'
      AND c.quantity = 42 AND c.amount = 0.001234
      AND ap.decision = 'approved'
      AND up.external_id = 'ci-restore-upload'
      AND up.status = 'published' AND up.completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'restored editorial relationships or data values invalid';
  END IF;

  -- A restored database must still enforce idempotency and permission checks.
  BEGIN
    INSERT INTO vns.jobs (kind, idempotency_key) VALUES ('render', 'ci-restore-job');
    RAISE EXCEPTION 'restored uniqueness constraint not enforced';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  BEGIN
    INSERT INTO vns.assets (story_id, kind, storage_key, rights_status)
      SELECT id, 'image', 'ci/uncleared', 'cleared'
      FROM vns.stories WHERE slug = 'restore-fixture-story';
    RAISE EXCEPTION 'restored rights constraint not enforced';
  EXCEPTION WHEN check_violation THEN NULL; END;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'touch_updated_at' AND tgrelid = 'vns.stories'::regclass
      AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'updated_at trigger not restored'; END IF;
END;
$verify$;

ROLLBACK;
