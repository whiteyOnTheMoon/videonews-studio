-- CI-only data for testing PostgreSQL 17 logical backup and fresh restore.
-- This is test content, not a production seed or migration.
BEGIN;

DO $seed$
DECLARE
  source_id uuid;
  license_id uuid;
  story_id uuid;
  script_id uuid;
  job_id uuid;
  video_id uuid;
BEGIN
  INSERT INTO vns.sources (name, canonical_url, trust_status)
    VALUES ('Restore fixture source', 'https://example.invalid/restore-source', 'trusted')
    RETURNING id INTO source_id;

  INSERT INTO vns.licenses (code, name, attribution_rule)
    VALUES ('CI-RESTORE', 'Fixture license', 'CI only')
    RETURNING id INTO license_id;

  INSERT INTO vns.stories (source_id, slug, title, summary, status)
    VALUES (source_id, 'restore-fixture-story', 'Recoverable draft',
            'Fixture representing editorial metadata', 'review')
    RETURNING id INTO story_id;

  INSERT INTO vns.claims (story_id, source_id, statement, evidence_url,
                          verification_status, verified_at)
    VALUES (story_id, source_id, 'Restore must preserve claim references',
            'https://example.invalid/restore-evidence', 'verified', now());

  INSERT INTO vns.assets (story_id, source_id, license_id, kind, storage_key,
                          rights_status, rights_verified_at, attribution)
    VALUES (story_id, source_id, license_id, 'image', 'ci/restore-image',
            'cleared', now(), 'Fixture source');

  INSERT INTO vns.scripts (story_id, version, body, status)
    VALUES (story_id, 1, 'Fixture script text', 'approved')
    RETURNING id INTO script_id;

  INSERT INTO vns.jobs (story_id, kind, status, idempotency_key,
                        attempt_count, max_attempts)
    VALUES (story_id, 'render', 'retry', 'ci-restore-job', 1, 3)
    RETURNING id INTO job_id;

  INSERT INTO vns.videos (script_id, render_job_id, storage_key, duration_ms, status)
    VALUES (script_id, job_id, 'ci/restore-video', 42000, 'rendered')
    RETURNING id INTO video_id;

  INSERT INTO vns.costs (job_id, provider, metric, quantity, amount, currency)
    VALUES (job_id, 'ci-only', 'tokens', 42, 0.001234, 'USD');

  INSERT INTO vns.approvals (video_id, reviewer, decision, comment)
    VALUES (video_id, 'ci-reviewer', 'approved', 'No real publication');

  INSERT INTO vns.uploads (video_id, platform, external_id, status, completed_at)
    VALUES (video_id, 'test-platform', 'ci-restore-upload', 'published', now());
END;
$seed$;

COMMIT;
