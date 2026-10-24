# P1-07 live proof and remaining acceptance checks

Operator-reported results on 2026-10-25:

- PostgreSQL 17 and Redis 7 healthy on the VPS, both without published host ports.
- Eleven schema migrations applied and verified.
- Redis named worker account authenticated; unrelated Redis key namespaces denied.
- The existing worker started with concurrency one and no public ports.
- One harmless BullMQ probe completed on the actual VPS. Its result remains stored and was subsequently checked using read-only commands.
- At that audit: zero editorial jobs, zero outbox entries, zero operator registry entries.
- Last reported capacity: 24 GB free disk (80% used) and 3.0 GiB RAM available.

**Not yet demonstrated:** a controlled live worker restart, live PostgreSQL outbox dispatch, live cross-store status synchronization, a comprehensive dead-letter history or real editorial research/video processing. The worker accepts only probes. Never dispatch editorial jobs to it.

**No-backup experimental exception:** the operator approved this limited deployment with zero backup spending and accepts potential permanent loss of live data. This does not satisfy the twelve disaster-recovery gates or demonstrate a usable restore.

## Proposed next controlled test

Before restarting the worker, inspect the complete, bounded BullMQ inventory using read-only access. Require no waiting, active, delayed, prioritized or failed jobs, and require that all completed records are the previously validated harmless probe type. Verify that PostgreSQL still has no editorial jobs or outbox intents. Any unexpected state blocks the restart; do not delete any evidence.

If clean, a subsequent targeted worker-only restart can establish that the existing worker reconnects to authenticated Redis and that the saved probe outcome survives. PostgreSQL, Redis, Web, API, and Cloudflare must stay running. Do not change existing volumes or launch a dispatcher or status synchronizer as part of this drill.
