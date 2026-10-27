# P2-02 – bounded quarter-hour feed scheduler (disabled rollout stage)

## Integration

`node apps/worker/dist/feed-scheduler-bounded.js --bounded` reuses the
existing `observeFeedOnce` runtime for every authorized interval. That path
revalidates the current Ed25519 signed source export against an independent
PostgreSQL high-water anchor, current database/host grants, pinned HTTPS,
the dedicated Redis/BullMQ queue, and the guarded PostgreSQL lease/commit.
It creates and closes its own database, Redis and queue connections for every
tick and makes **no** editorial publication request.

The scheduler is a **bounded operational stage** rather than unattended
24/7 operation: 1–16 attempts, 15-minute UTC windows, at most one attempt
per window and no replay/backfill of missed intervals. Startup more than
90 seconds into a slot defers to the next slot. The queue's existing
deterministic slot job ID and persisted Redis state prevent duplicate jobs
across concurrent dispatch attempts. Database source leases are still the
authoritative per-source concurrency/rate-limit boundary.

On a failed one-shot run, the service emits a sanitized
`feed_scheduler_tick_failed` event and attempts only the next eligible slot.
After the operator-selected consecutive-failure limit (1–3), it emits
`feed_scheduler_halted` and exits nonzero. SIGINT/SIGTERM stops the
process before the next slot; an in-flight PostgreSQL operation is allowed
to settle rather than silently cancel a commit.

## Strict activation contract

All existing `feed-observe-once` approvals and secrets remain required,
including independently reviewed rights, current signed source inbox,
out-of-band pinned Ed25519 public key, separately protected PostgreSQL anchor,
reviewed host allowlist, Redis/DB login identity and dedicated queue.

Additionally require **all** of:

- `VNS_FEED_SCHEDULER_ENABLED=true`
- `VNS_FEED_SCHEDULER_OPERATOR_ACK=true`
- `VNS_FEED_SCHEDULER_MODE=bounded`
- `VNS_FEED_SCHEDULER_MAX_TICKS`: integer 1–16
- `VNS_FEED_SCHEDULER_FAILURE_LIMIT`: integer 1–3
- `VNS_FEED_SOURCE_BOOTSTRAP=false`
- `VNS_FEED_RUNTIME_MODE=single_pass` (underlying observed job contract)

There is no implicit default for the counts; empty/zero values refuse
execution. Run the distinct `feed-scheduler` profile in
`compose.feed-observation.yaml` only after a separately approved VPS
rollout plan. The new Docker profile inherits the observer's non-root UID,
limited resources, no-new-privileges, restricted mounts, backend + feed egress
networks and database/Redis dependencies. It has its own disabled defaults.

## Operational limits and unfinished requirements

This is **not** a continuously autonomous scheduler. It does not provision
live sources, a dedicated long-running queue-only producer, separate
persistent consumer deployments, bounded dead-letter inspection, on-call
alarm delivery or trusted automated credential rotation. After 16 slots
(maximum four hours), a separate operator-controlled restart is necessary.
The BullMQ worker is still instantiated within each one-shot observation
rather than maintained by a separately scalable service.

Because `feed-queue-contract` currently treats any failed source as
a failed tick, one failing provider may fail that whole slot, but the
remaining source polls still execute independently inside that tick and
the bounded scheduler can attempt the **next** authorized slot. There is
no automatic retry storm. Retained failed BullMQ jobs require operator inspection before
further promotion.

Offline unit tests prove fail-closed gates, UTC slot alignment, no catch-up
burst, run limit, sanitization, recovery across slots and signal shutdown.
Real Redis/PostgreSQL CI tests prove the underlying one-shot queue/persist
pipeline, not a multi-hour live end-to-end loop. Independent real VPS
monitoring, alert delivery, recovery and revocation-safe pre-HTTPS transport
must still be signed off. **P2-02 remains open.**

No real news source is fetched, no publisher/AI provider is enabled, no
production VPS change has been made by merging these files.
