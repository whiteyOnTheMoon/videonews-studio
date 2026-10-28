# P1-09 – Redis 8.4.8 production deployment

## Verified VPS state, 2026-10-28

- Redis 8.4.8 is running with an immutable image digest.
- The restored volume is `videonews-studio_redis_p109_restored`.
- The original `videonews-studio_redis_data` is retained for recovery.
- The original P1-07 completed probe receipt was recovered and verified.
- Worker, PostgreSQL, API and Web were validated after recovery.
- ACL restrictions for the worker and provider producer were verified.
- The original Redis 7.4.11 deployment had ACL/EXEC AOF replay errors.

This document records an observed deployment, not approval for automatic
production changes, provider spending or broader service activation.

## Mandatory Compose selection

Always include this additional file for production deployment operations:

`-f deploy/compose.redis84-production.yaml`

The Compose files must be supplied in this order:

1. `compose.yaml`
2. `deploy/compose.worker.yaml`
3. `deploy/compose.redis84-production.yaml`

The base `compose.yaml` alone is NOT the production Redis definition.
Running Compose without the override may reselect Redis 7 and the old volume.

Before any write-capable Docker Compose command, render the complete
configuration and run `scripts/check_redis84_production_compose.py`
against both the base and production-rendered JSON configurations.

The review guard rejects an unpinned image, incorrect Redis volume,
unexpected changes to other services, missing ACL configuration,
public port exposure and disabled protected mode.

## Recovery and operations

- Do not delete the original Redis volume, the frozen AOF backup
  or the private reconstruction evidence as part of P1 acceptance.
- Do not perform a Redis 7 rollback against an AOF written by Redis 8.
- Production changes need an explicit maintenance approval and new
  read-only preflight.
- CI uses synthetic test inputs; it cannot verify VPS live state.
- Preserve Redis ACL secrets outside Git.
- Do not use `docker compose down -v`, `FLUSHALL`, `FLUSHDB`,
  or an unreviewed AOF rewrite as a recovery shortcut.
- After any Redis maintenance, validate the retained P1-07
  receipt, queue counts, both ACL identities and Redis startup logs.
