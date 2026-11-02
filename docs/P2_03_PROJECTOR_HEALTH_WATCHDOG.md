# P2-03: Continuous projector health and bounded PostgreSQL calls

**Status: Code-only release. No VPS services, live feeds or approvals are activated.**

The already opt-in `feed-project-continuous` component persists event
candidates and ranking projections for **three to five operator-selected,
currently approved source IDs**. Unlike the feed producer and consumer,
it previously had no container health probe; an unresponsive database
projection could remain alive without showing an unhealthy state.

## Health contract

- The new `feed-projector-healthcheck.js` probes only a private
  rootless-UID 10004 file at `/tmp/vns-feed-projector-health.json`.
  It uses the existing strict heartbeat reader: regular file, link count
  one, exact owner UID and mode 0600, current PID, no future timestamp,
  bounded age, and state `ready`.
- Heartbeats are atomic and written every 20 seconds to container-local
  tmpfs. Docker samples every 30 seconds with 5-second timeout, three
  retries and 60-second startup allowance. The existing Beszel setup may
  observe Docker unhealthy/stopped states when separately configured.
  This code does **not** provision or claim notification receipt.
- During the explicitly configured 15–60-minute idle interval, the
  projector remains ready. During a single DB source projection, the
  progress watchdog refuses to continue reporting ready after 60 seconds.
  Clock rollback or heartbeat write failure also stops health admission.
- PostgreSQL server `statement_timeout` is 10 seconds; pg client
  `query_timeout` and transaction-idle timeout are 15 seconds. This
  protects both short one-shot and continuous projector connections.
  Queries that fail abort the continuous loop; there is no implicit
  requeue, publish, approval change or automatic restart.
- The shutdown/exception path records `stopped` and removes timers.
  The process never exposes source IDs, article metadata, passwords or
  SQL errors through the health file.

The one-shot projector remains without a misleading permanent healthcheck.
No HTTP egress, Redis credentials, source-signing key or publisher grants
are introduced. The existing independent projector database identity
and guarded SQL execution remain mandatory for each source.

## Verification and rollout boundary

Disposable CI checks the watchdog with fake clocks, private on-disk
heartbeat acceptance/rejection, actual worker compilation and the
disabled Compose overlay. It does **not** prove production source rights,
remote signing-key trust approval, real offsite recovery or Beszel alert
delivery. Do not enable continuous projection until signed source imports,
the separate remote anchor, licensed feed access and one-slot PostgreSQL
canary have been independently approved.
