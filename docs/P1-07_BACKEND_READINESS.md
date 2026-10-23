# P1-07 — Data and job queue rollout gates

Status: **implementation in progress, not deployed**.

## Existing evidence

- P1-05 has a reversible PostgreSQL 17 `vns.*` migration plus offline integration checks.
- `compose.yaml` defines opt-in `data` services PostgreSQL and Redis, and an opt-in `worker` scaffold.
- The worker currently logs and exits; **it does not process BullMQ jobs**.
- The existing Redis service has protected mode enabled but **no authentication**. Do not deploy it as a queue service.
- P1-06's authenticated web/API deployment must remain running unchanged during preparatory work.

## Required before any VPS startup

1. Add Redis authentication using an operator-provisioned secret/ACL, without passwords in Git, process arguments, logs, or Compose YAML; verify the redis process can read the secret as its effective UID.
2. Add `bullmq` and Redis client runtime dependencies with a reviewed lockfile and Docker worker runtime dependencies; introduce minimal worker queue handling with bounded retries and concurrency exactly one.
3. Define durable and idempotent job bookkeeping between `vns.jobs` and BullMQ (enqueue, retry, completion and crash recovery); no rendering, research or upload side effects at this stage.
4. Gate queue submission behind admin authorization; do not expose Redis, PostgreSQL or worker via host ports.
5. Verify PostgreSQL and Redis health, authenticated Redis access, worker graceful shutdown and retry behavior in disposable CI integration services.
6. Review disk/memory headroom, persistence, secret handling, restore strategy, migration execution and operator rollback **before** approving persistent VPS databases. No new production data without a consciously accepted recovery policy.
7. Keep `data` and `worker` profiles disabled until tests pass and a separate operator deployment approval is obtained.

## Read-only validation

Run locally or in CI with safe placeholder PostgreSQL secret:

```sh
python3 -m unittest discover -s scripts -p 'test_p1_07_readiness.py'
docker compose --profile preview --profile data --profile worker config --format json | python3 scripts/p1_07_readiness.py
```

This guard checks only the *existing offline topology*. A PASS does **not** certify production Redis security, BullMQ functionality, PostgreSQL durability or VPS deployment readiness.

## VPS rollback constraints

- No action in this pull request should recreate web/API or touch the Cloudflare tunnel.
- Preserve P1-06 web/API digest pins and the operator's private rollback file.
- Do not invoke `docker compose --profile data up` or `--profile worker up` for this milestone.
- GHCR images are private and updates must be digest-pinned and approved separately.
