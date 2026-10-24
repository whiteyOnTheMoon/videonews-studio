# P1-07 — Fresh live database schema bootstrap (experimental, NO BACKUPS)

**Operator status (2026-10-25):** P1-07 rollout and controlled container starts authorized without backups; PostgreSQL 17 and Redis 7 were successfully started on VPS with `scripts/p1_07_data_canary.sh`, and both reported healthy. Existing VideoNews web/API/tunnel remained healthy. This does **not** establish backup/recovery readiness: all twelve normal recovery gates stay false.

## Goal and boundary

Install exactly the versioned `0001` through `0011` `vns` migrations only into the **already running, healthy, empty** `videonews-studio-postgres-1` PostgreSQL container. The helper `scripts/p1_07_schema_bootstrap.sh` checks Docker Compose labels, project, service, PostgreSQL server version 17, database identity, privileges, existing `vns` schema/roles, repository status, local migration files, free disk and RAM. It **refuses** a previously initialized or partially initialized schema. It does not run `db/scripts/test_migrations.sh` because that script is disposable-GitHub-CI-only and destructive within its own fixture.

**Important:** each migration is independently transactional, but the entire 11-step sequence is **not one global transaction**. If an intermediate migration fails, leave existing state untouched and investigate; do **not** rerun, drop roles/schema or reset the database automatically. There is no backup and no guarantee of recovering state following failure.

The migration helper does not start or restart Docker services, publish ports, create editor identities, enable API feature flags, start BullMQ workers, or submit editorial jobs. The operator registry is expected to remain empty.

## CI evidence required before VPS use

A new GitHub Actions workflow uses a separately named disposable PostgreSQL Compose project with test-only credentials to run the **same** bootstrap script, then verifies all 11 migration ledger entries and rejection of a repeated attempt. Only the CI project is removed afterward. Do not run the helper on live data before that workflow passes on the merged revision.

## Operator commands after CI is green

**Never paste secrets or `docker inspect` environment values.** From the previously inspected VPS, check the clean `main` checkout and only fast-forward:

```bash
cd /home/ap/www/videonews-studio || exit 1
git status --short
git pull --ff-only origin main
bash scripts/p1_07_schema_bootstrap.sh preflight
```

Only if `preflight` prints PASS and the source commit matches the reviewed revision, use:

```bash
bash scripts/p1_07_schema_bootstrap.sh apply
bash scripts/p1_07_schema_bootstrap.sh status
bash scripts/p1_07_data_canary.sh status
```

If any preflight or migration fails, **stop** and share only sanitized status/error text, without secret values. No destructive recovery commands are authorized. There is no rollback to lost data.

**Next independent stage:** confirm actual PostgreSQL roles and Redis ACL authentication before enabling a worker. The worker is probe-only. The current API/web images were not modified and may not include any new optional data features from GitHub. See [canary runbook](P1-07_DATA_CANARY_RUNBOOK.md) and [original recovery gates](P1-07_RECOVERY_RUNBOOK.md).
