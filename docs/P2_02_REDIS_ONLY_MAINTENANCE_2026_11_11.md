# P2-02 – Redis-only maintenance: read-only operator and disposable rollback drill

**Source-only. Not authorization for VPS changes.** The operator approved
developing and testing the Redis-only maintenance safeguards, but did **not**
approve any production container recreation, Redis command or outage.
This PR has **no** live `--execute`, `--recreate`, `--rollback` or `ACL LOAD`
mode. No deployment follows automatically from a GitHub merge.

## Observed pre-maintenance baseline (operator supplied, 2026-11-11)

- VPS/GitHub checkout `31b97f6da57a3b3e7603e7abf6ea51aaeb3179d5`
  at this project's design start; later SHA must be freshly pinned.
- Redis 8.4.8 exact immutable image digest from
  `deploy/compose.redis84-production.yaml`, private network, healthy,
  no restarts, no published host port.
- Active `videonews-studio_redis_p109_restored` AOF volume; previous
  `videonews-studio_redis_data` retained. AOF last write/rewrite OK,
  no rewrite in progress and Redis not loading. Three clients in
  an earlier one-time observation; a count is not a maintenance lock.
- Existing P1 probe-only worker running; P1 BullMQ completed=1, pending=0;
  P2 feed BullMQ completed=4, failed=6, pending=0, no repeat schedules.
  PostgreSQL `vns.jobs` and `vns.job_outbox`: zero rows.
  These numbers may change; they are **not** guaranteed stable.
- The sixth ACL account `vns_feed_status_studio` has been installed
  in the 0644 **host** `secrets/redis_acl` file with a protected operator
  password and backup. The live Redis container still holds the
  **previous ACL file inode**, so the sixth account is **not active**.
- Operator manually confirmed an external backup and isolated restore
  before the file-only ACL change. The repository has **not**
  independently verified backup provenance, RPO/RTO, scope or restoration
  of the active Redis 8 AOF volume; do not equate operator attestation
  with a passed production restore drill.
- Disk free: roughly 13 GiB at the last observation.

## Two strictly read-only operator modes

`scripts/p2_02_redis_only_maintenance.py` uses Python's standard
library, and has no write-capable Docker, Redis or Git path.

- `--preflight --expected-sha SHA` requires exact UID 1000, clean
  `main` at that SHA; validates the **installed** private Studio ACL,
  renders Compose with **both** `data` and `worker` profiles and the exact
  three production files; invokes the existing reviewed Redis 8 guard.
  It checks the live image reference **and image ID**, Redis health,
  no restart count drift, private internal backend network, no published
  ports, no running source/feed services, the exact mounted AOF volume
  and retained old volume, the ACL bind mount, and at least 8 GiB
  available. Requires that Redis's ACL mount remains on the **old inode**.
- `--postcheck --expected-sha SHA` repeats those checks but requires
  the live Redis mount to point to the **new host ACL inode**.
  It reads the private Studio status credential without logging it,
  authenticates as `vns_feed_status_studio` on the private Redis address,
  checks PING, and requires `NOPERM` for an off-scope read. This checks
  the new account is live, **not** that all BullMQ/P1/P2 data are intact.
  The previously established root-only P1/P2 receipt and queue audits,
  persistence status and application health must be rerun separately.

The operator emits a compact no-secret JSON verdict. A missing or
ambiguous piece of evidence fails closed; it does not patch files,
stop/restart Redis, load ACLs, enqueue jobs or publish anything.

## Mandatory independent controls before any *future* production switch

1. Independently prove the **actual Redis 8 AOF volume** can be restored
   offline, including ACL recovery, P1 probe receipt and both queues.
   Retain the previous volume, frozen AOF backup and baseline ACL. Verify
   off-VPS backup provenance and restore access. Define the acceptable
   outage and lost-data budget. A fresh AOF success flag is not enough.
2. Identify and block **new producers**, schedules, external submissions
   and unreviewed worker side effects throughout the maintenance interval.
   Re-check P1 and P2 queue counts, PostgreSQL outbox and active clients
   immediately before a separately authorized cutover. The P1 worker
   remains connected even when its queue is empty; coordinate its
   interruption/reconnection explicitly. Preserve IDs/labels for
   Web, API, PostgreSQL, Worker and Cloudflare.
3. Render and compare exactly these Compose files in order:
   `compose.yaml`, `deploy/compose.worker.yaml`,
   `deploy/compose.redis84-production.yaml`, with profiles `data`
   and `worker`. The **base-only** Compose selects Redis 7 and an old
   volume: it is unacceptable. Any eventual command must explicitly
   select **only Redis**, disable dependency recreation and builds,
   keep Redis 8 digest and `redis_p109_restored`, and exclude
   `down`, `-v`, `--renew-anon-volumes`, `ACL LOAD`,
   `FLUSH*`, resets and indiscriminate retries.
4. Obtain a **new, explicit live maintenance authorization** tied to
   the expected Git SHA, runtime image ID, volume ID, exact operator
   baseline, outage window and tested recovery evidence. **No live
   command is provided by this PR**. Develop/review the one-shot
   execute-and-stop runbook in a later approved change.
5. After any approved switch, run the postcheck, two existing P2 ACL
   identities, the P1 worker retained probe receipt, both P1/P2 queue
   snapshots, Redis AOF/health, PostgreSQL outbox and all running
   service identities. A missing check is an incomplete cutover, not
   a success.

## Rollback and stop conditions

On a failed production Redis start **do not** blindly retry, delete a
volume, change Redis version, rewrite AOF, run `docker compose down -v`,
or silently revert the host ACL. Preserve the image IDs, original ACL
backup, source volume and evidence. Use a separate operator-approved
isolation/recovery decision, with a verified restore copy, before
attempting another Redis container. Any rollback must keep the
**same pinned Redis 8 family** and original intended AOF data; the
historic Redis 7 volume is **not** an automatic fallback for Redis 8 AOF.

The GitHub Actions rehearsal uses a short-lived container
(`--network none`) and a separate synthetic AOF volume to verify:

- A new atomically replaced ACL file does not change the existing bind
  inode; the new user is unavailable until the **one-service recreation**.
- A recreated Redis 8 loads only the new role; synthetic P1/P2 retained
  completion/job hashes survive the AOF restart, while cross-queue
  reads remain forbidden.
- A deliberately corrupted ACL prevents startup. A synthetic rollback
  to the original ACL under the **same pinned image and retained AOF volume**
  restores the original identities and jobs; the new role is then absent.

This is **isolated rollback evidence only**, not a claim that the VPS
can recover from lost/corrupt AOF files or that production rollback
is independently approved. No production service, secret, VM or
database is accessed by CI.
