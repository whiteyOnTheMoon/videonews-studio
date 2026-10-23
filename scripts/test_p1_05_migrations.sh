#!/usr/bin/env bash
# Integration test on an explicitly designated, disposable PostgreSQL database.
set -euo pipefail
: "${P1_05_TEST_DATABASE_URL:?Set a disposable PostgreSQL test database URL}"
: "${P1_05_ALLOW_DESTRUCTIVE_TEST:?Set P1_05_ALLOW_DESTRUCTIVE_TEST=yes}"
if [[ "$P1_05_ALLOW_DESTRUCTIVE_TEST" != "yes" ]]; then
  echo "Refusing destructive test without explicit yes" >&2
  exit 2
fi
command -v psql >/dev/null || { echo "psql is required" >&2; exit 2; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
psql_test() { psql "$P1_05_TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 "$@"; }
# Always start clean; never run this against a valuable database.
psql_test -f "$root/db/migrations/001_initial.down.sql" >/dev/null
psql_test -f "$root/db/migrations/001_initial.up.sql" >/dev/null
count="$(psql_test -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('sources','stories','claims','assets','licenses','scripts','jobs','videos','costs','approvals','uploads')")"
[[ "$count" == 11 ]] || { echo "Expected 11 tables; got $count" >&2; exit 1; }
psql_test <<'SQL'
INSERT INTO sources(name,homepage_url) VALUES ('Example','https://example.invalid');
DO $$
BEGIN
  BEGIN
    INSERT INTO sources(name,homepage_url) VALUES ('Example','https://other.invalid');
    RAISE EXCEPTION 'Missing unique constraint';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
INSERT INTO stories(source_id,external_id,title,original_url) VALUES (1,'news-1','Test','https://example.invalid/news-1');
DO $$
BEGIN
  BEGIN
    INSERT INTO stories(source_id,external_id,title,original_url) VALUES (1,'news-1','Duplicate','https://example.invalid/news-2');
    RAISE EXCEPTION 'Missing story deduplication';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
DO $$
DECLARE before_update timestamptz; after_update timestamptz;
BEGIN
  SELECT updated_at INTO before_update FROM sources WHERE id=1;
  PERFORM pg_sleep(0.02);
  UPDATE sources SET approval_status='approved' WHERE id=1;
  SELECT updated_at INTO after_update FROM sources WHERE id=1;
  IF after_update <= before_update THEN RAISE EXCEPTION 'updated_at trigger did not run'; END IF;
END $$;
SQL
psql_test -f "$root/db/migrations/001_initial.down.sql" >/dev/null
count="$(psql_test -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('sources','stories','claims','assets','licenses','scripts','jobs','videos','costs','approvals','uploads')")"
[[ "$count" == 0 ]] || { echo "Rollback left $count tables" >&2; exit 1; }
echo "P1-05 up/down integration test passed."
