# P2-02 continuous feed operations — production acceptance runbook

**Release status: NOT DEPLOYED / NOT OPERATIONALLY ACCEPTED.** This implementation provides an opt-in runtime and disposable-CI verification, not evidence of licensed real feed access, independent signing-key custody, live restore or Beszel alarm delivery. No VPS changes, scheduled restart, source access or paid provider use are authorized by this document.

## Components and boundaries

- `feed-producer-continuous` is independent from the legacy `feed-producer` (16-tick bounded mode) and `feed-observer`. Its Docker profile is **disabled by default**, no DB/anchor/signer secrets are mounted, and it has backend Redis access only; **never run producer variants concurrently**. New `VNS_FEED_RUNTIME_MODE=continuous_producer` must be explicitly approved separately from the bounded producer mode.
- At the start of each UTC 15-minute slot (first 90 seconds only) it enqueues at most one deterministic `vns-feed-tick-<slot>` BullMQ job. Restarts do not replay missed slots; retained job IDs prevent re-insertion within a slot. The consumer validates current signed and independently anchored source approvals, roles, rights and host allowlists for *every* actual fetch. Source-specific polling intervals are enforced by the existing guarded poller/database authority; none are hardcoded into the producer.
- Every 30 seconds, an isolated Redis-only inspection samples waiting/active/delayed/failed/completed/paused jobs, queue pause state and oldest pending job timestamp. Failure to inspect, *any failed job*, a paused queue, pending backlog above the approved limit, pending age beyond the approved maximum, clock rollback, or a completed-job retention ceiling stops the scheduler **without continuing to ingest new work**.
- `feed-consumer` now requires an explicit 30–600-second per-job watchdog. An overlong or stalled job halts the worker, forces shutdown where appropriate and requires manual triage; BullMQ automatic stalled-job retries are disabled. Failed jobs remain retained and are not auto-requeued, republished or silently removed.
- Both the continuous producer and consumer write private, atomic health heartbeats into their existing container-local tmpfs. Their Docker healthchecks fail for missing/stale/untrusted/stopped records; stopped containers are also visible to an operator's infrastructure monitor. There is **no built-in e-mail/Telegram/webhook sender**: the existing shared Beszel setup remains the intended alert transport.

## Required environment admission (no passwords or keys in Git)

The continuous producer needs **all** existing `VNS_FEED_RUNTIME_*`/`VNS_FEED_RIGHTS_ATTESTED`/`VNS_FEED_NETWORK_APPROVED`, source/anchor and queue approval flags, valid approved-source host allowlist, `VNS_FEED_SOURCE_BOOTSTRAP=false`, existing producer identity/ack flags and the following *additional* settings:

| Setting | Required |
|---|---|
| `VNS_FEED_RUNTIME_MODE` | `continuous_producer` (fixed in optional Docker profile) |
| `VNS_FEED_SCHEDULER_ENABLED`, `VNS_FEED_SCHEDULER_OPERATOR_ACK` | `true`, distinct operator approval |
| `VNS_FEED_SCHEDULER_MODE` | `continuous` (fixed in optional Docker profile) |
| `VNS_FEED_CONTINUOUS_ENABLED`, `VNS_FEED_CONTINUOUS_OPERATOR_ACK` | `true` after distinct rollout sign-off |
| `VNS_FEED_CONTINUOUS_MAX_BACKLOG` | Integer 1–20 |
| `VNS_FEED_CONTINUOUS_MAX_COMPLETED_JOBS` | Integer 100–100000; halt before unbounded Redis retention |
| `VNS_FEED_CONTINUOUS_MAX_PENDING_AGE_MINUTES` | Integer 15–29, strictly below the 30-minute stale-delivery limit |
| `VNS_FEED_CONTINUOUS_ENQUEUE_FAILURE_LIMIT` | Integer 1–3 |
| `VNS_FEED_CONSUMER_MAX_JOB_SECONDS` (consumer only) | Integer 30–600 |

All controls default to **disabled/invalid**. The producer uses an existing `vns_feed_producer_*` Redis ACL login and a distinct password file `VNS_P2_FEED_PRODUCER_REDIS_PASSWORD_FILE` provisioned outside Git. It has no source/DB/publisher key mount and no public egress network. Redis ACLs must be explicitly tested for BullMQ scripts, readiness `INFO` and restricted `bull:vns:feed:*` keys; do not expand to administrative commands merely to pass a test.

## Safe, operator-authorized acceptance stages

1. Record immutable main commit and image digests; independently approve at least 3 licensed sources, terms/rate limits, signer's offline custody/rotation, remote monotonic anchor TLS/identity and separate named PostgreSQL/Redis principals. Prepare offsite encrypted backups and **prove restore**, including Redis queue continuity, before enabling feeds.
2. Run the disposable GitHub Actions test suites and record successful isolated Redis/PostgreSQL tests: distinct Redis ACL identities, consumer restart, a continuous slot, a deliberately failed malformed job retained in the failed set, followed by an admission stop with **zero further enqueue**. Unit tests cover paused, stale, missing/invalid state and rollback clocks.
3. On an authorized inactive VPS stage, verify the new Docker Compose overlay and exact secret mounts; verify no public ports and no implicit startup. Test health transitions for `feed-consumer` and `feed-producer-continuous` with synthetic authorized data only. Do not start live feeds as part of a healthcheck drill.
4. Configure the *existing* Beszel Hub/Agent to observe both containers' `unhealthy` and `exited` conditions, where supported. Perform a **safe, observable end-to-end test notification** to the operator through the existing channel. Record timestamp, recipient receipt, signal source, reset and alert escalation; **a CI pass or health status alone is not an alert delivery proof**.
5. With separate written approval of a particular release, image set, source set, authorized source times and rollback plan, perform a limited live one-slot observation first. Verify DB deduplication, 304/ETag, source intervals, queue lag, failed jobs, host allowlists, signed-source revocations and signed audit. Enable continuous scheduling only after that independent acceptance.

## Incident response and dead-letter handling

- **First response:** stop `feed-producer-continuous` / disable its separate approval gate. Do not delete queue keys, widen Redis ACLs, rewind the source anchor, restart other projects, or turn on a fallback producer to mask failure.
- Use the read-only queue inventory entrypoint `npm run feed-queue-operations --workspace @vns/worker` (requires the separately approved continuous-producer runtime environment and read-only operations access). It outputs only aggregate waiting/active/delayed/failed counts and safe failed job IDs, returns nonzero for unhealthy state, and never outputs raw queue errors or job payloads. No job state is mutated.
- Preserve failed job IDs, timestamped queue counts, consumer halt event and signed source/export revisions in the incident record. Review job payload and error details *only* through separately authorized private operational tooling; never paste sensitive payloads into logs, alerts or tickets.
- **No automatic retry or cleanup.** Independent operator approval is required for removing or requeuing any failed job, after rights/claims are reassessed and offsite incident evidence is archived. Completed-job retention ceiling deliberately halts rather than deleting audit evidence; export and verify an immutable copy before approving any bounded pruning. If no authorized safe cleanup exists, leave the producer stopped.
- For rollback, stop the new producer first, then worker as required. Maintain Redis AOF/PostgreSQL consistency and independently anchored source revision floors; restart only known-good image digests compatible with migrations, and never start the legacy and continuous producers together.

## Explicit remaining external release blockers

**Not proven here:** real signed-license access, remote anchor custody and revocation, offsite restore/RPO/RTO, VPS UID/secrets/ACL admission, Beszel live notification, approved operator escalation and recovery decisions, GitHub protection/visibility decision, and actual canary/rollback drill. `#17` and the P2 rollout gate remain **open** until independently reviewed evidence is attached. A successful merge is **code integration**, not production activation.
