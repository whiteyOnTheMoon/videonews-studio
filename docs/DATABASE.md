# P1-05 PostgreSQL schema and migrations

This initial schema introduces the following 11 tables: `sources`, `stories`, `claims`, `assets`, `licenses`, `scripts`, `jobs`, `videos`, `costs`, `approvals` and `uploads`.

## Design

- PostgreSQL 17 compatible; bigint identity primary keys and `timestamptz` audit fields.
- URL and natural-key uniqueness guard source/story duplication; SHA-256 prevents duplicate asset blobs.
- Foreign keys enforce story/claim/script/video/approval/upload relationships.
- Default asset rights status is `blocked`; source approval defaults to `pending`.
- Approval records are retained; every upload references an approval for **the same video** via composite foreign key. The database schema does **not** itself prove that the latest approval is positive: the upload service must explicitly validate that before publication (P5).
- Cost amounts are nonnegative and stored as exact numeric values.
- `updated_at` is refreshed by a shared trigger upon any update.

## Applying the migration

**Do not run against production until PostgreSQL is enabled, backup/recovery is planned, and deployment reviewed.** The current VPS preview does not include a running database service.

On a **new, empty** PostgreSQL database, with `psql` available:

```bash
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f db/migrations/001_initial.up.sql
```

Rollback is **destructive** and permanently drops the tables and contained data:

```bash
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f db/migrations/001_initial.down.sql
```

These files are the initial baseline; do not re-apply the up script to an already migrated database. A tracked migration ledger/runner can be introduced before production rollout.

## Integration testing

Provide an **empty, disposable** PostgreSQL database, not production or staging. The script removes its P1-05 tables before and after testing:

```bash
P1_05_TEST_DATABASE_URL='postgresql://.../disposable_test_db' \
P1_05_ALLOW_DESTRUCTIVE_TEST=yes \
bash scripts/test_p1_05_migrations.sh
```

The test covers all 11 tables, duplicate rejection, `updated_at` trigger behavior, and rollback. GitHub CI remains to be wired to a PostgreSQL test container in P1-08.

## Not in scope

P1-05 defines the schema only. Database activation on VPS, secrets provision, background queue, authorization checks and publication approvals are separate deliverables. No automatic uploads or public DB ports are introduced.
