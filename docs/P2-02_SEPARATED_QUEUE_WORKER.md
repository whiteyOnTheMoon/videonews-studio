# P2-02: Separate bounded producer and persistent feed consumer

**Status: CODE ONLY — NOT DEPLOYED, NOT PROD-ACCEPTED.** This is a gated opt-in alternative to the existing single-pass observer and bounded scheduler, not authorization for VPS changes, source access, new Redis ACLs, or continuous unattended scheduling.

## Architecture

- `feed-producer` is a separate bounded process that only enqueues deterministic, source-free 15-minute BullMQ slots (at most 16 per explicitly authorized process); it has no PostgreSQL, source inbox, anchor secret or HTTP-feed transport mount. It must have a separately provisioned producer-only Redis ACL.
- `feed-consumer` is a persistent BullMQ worker, concurrency=1. It receives only a slot number/job ID, never URLs or source approvals from Redis. For **each job** it re-opens and attests the least-privileged PostgreSQL session, independently protected TLS trust anchor, pinned Ed25519 publisher identity, signed source inbox and current approved host policy. The guarded database functions check current source and host authorization before ingesting. The worker uses a separate consumer Redis ACL.
- Worker-received forged, wrong-queue and stale (30+ minute) slots fail closed. Redis jobs have no automatic retries and are retained on success/failure for inspection. Three consecutive failed jobs halt the consumer; it also stops on Redis/worker connection errors. No implicit auto-publication or AI call.
- The legacy `feed-observer` and `feed-scheduler` remain intact as fallback one-shot diagnostics. Never operate either legacy role concurrently with the separated roles until queue ownership / rollback has been operator-tested.
- `feed-producer` and `feed-consumer` Compose profiles are disabled unless explicitly selected, and **all new flags default to false**. Starting a profile does not bypass the older runtime/rights/anchor/queue gates.

## Gates

Both roles require all existing `readFeedRuntimeAdmission` flags, configured approved hosts, fixed container secret paths and `VNS_FEED_SOURCE_BOOTSTRAP=false`.

Producer alone: `VNS_FEED_RUNTIME_MODE=bounded_producer`, `VNS_FEED_SEPARATE_PRODUCER_ENABLED=true`, `VNS_FEED_SEPARATE_PRODUCER_OPERATOR_ACK=true`, Redis user `vns_feed_producer_*`, plus existing bounded scheduler flags, max ticks and failure limit. Redis ACL verification must include the narrowly scoped read-only `INFO` command needed by ioredis readiness checks while denying Redis administration and keys outside `bull:vns:feed:*`. Producer Redis secret comes exclusively from operator-supplied `VNS_P2_FEED_PRODUCER_REDIS_PASSWORD_FILE`; it must be verified to have only enqueue privileges for the isolated BullMQ namespace.

Consumer alone: `VNS_FEED_RUNTIME_MODE=persistent_worker`, `VNS_FEED_SEPARATE_WORKER_ENABLED=true`, `VNS_FEED_SEPARATE_WORKER_OPERATOR_ACK=true`, Redis user `vns_feed_consumer_*`. Its existing secret mounts must be separately provisioned, host-permission-checked and attested before startup. The consumer remains running until signaled, Redis connection failure, or the configured failure stop. Its restart policy is deliberately `no` until recovery/monitoring are proven.

## Non-negotiable remaining work before rollout

1. CI validation for this branch, plus real isolated PostgreSQL/Redis **split-process** integration and restart/recovery tests. Unit tests alone do not prove this architecture.
2. Validate least-privileged Redis ACL compatibility, producer-only permissions, consumer-only permissions, persistent queue recovery, backlog alerts, dead-letter procedure and resource limits. BullMQ may require more Redis commands than a simplified ACL allows.
3. Operator provision independent signing and revision anchor, personal DB identities, restricted Linux users and offsite backup/restore.
4. Prove actual alert delivery via Beszel and an application-level queue-backlog/failure signal. A log event alone is not an alert.
5. Confirm separately approved source licenses/ToS, server-side rights, release commit, image digests, migration compatibility, rollback and distinct authorizations for each VPS stage.
6. Decide how to retire bounded 16-tick producer in favor of an approved always-on scheduler with admin-configured per-source intervals. Do not silently enable permanent scheduling here.

Do **not** close #17 or claim production-readiness based solely on this code or CI.
