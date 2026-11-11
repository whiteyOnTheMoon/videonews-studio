# P2-02: Read-only Redis 8 AOF capture-window observation gate

## Why this exists

The VPS's Redis 8.4.8 uses an ext4-backed Docker named volume
`videonews-studio_redis_p109_restored`. The latest read-only audit found
an 88-byte AOF manifest, one base, one incremental AOF, and 8464 KiB
of data. No source files have been copied or restored on production.

Redis's official multi-part AOF backup guidance warns that copying
while an AOF rewrite runs can yield an invalid archive. Its recommended
production backup procedure temporarily disables automatic AOF rewrites,
verifies no rewrite is active, then copies the directory and restores
the setting. **This project does not yet authorize such a live
configuration change.** Redis 8.4.8 also lacks Redis 8.10's native
BACKUP command family.

Reference: https://redis.io/docs/latest/management/persistence/
INFO field definitions: https://redis.io/docs/latest/commands/info/

## Exact scope

`scripts/p2_02_redis8_capture_window.py` is a **pure function** for
independently collected, sanitized before/after observations. It has no
network, Redis, Docker, filesystem, credential, source-copy, or
production-execution capability.

It requires the same pinned container ID, Redis image and source volume,
a non-regressing uptime, AOF enabled, persistence status `ok`,
no scheduled or in-progress rewrite, stable rewrite counters and
AOF sizes, no pending fsync, and unchanged source-file inode, timestamps,
sizes and hashes. Missing fields fail closed.

The field `observation_stable=true` means **only** that these reported
read-only observations pass this limited cross-check. In particular,
two observations cannot exclude every transient intervening event.
No actual observer has been approved or deployed yet. No observed value
can prove that automatic rewrites were disabled throughout the capture
or that an archive is point-in-time consistent.

Even if all checks pass, the module ALWAYS reports:
- `point_in_time_consistency_proven=false`
- `independent_backup_verified=false`
- `isolated_redis_replay_verified=false`
- `production_capture_authorized=false`
- `redis_only_cutover_authorized=false`

The test suite contains **only synthetic values**. Do not put real
AOF contents, Redis credentials, hashes from ACLs, job IDs or job payloads
in GitHub, logs, chat or CI.

## Subsequent independently reviewed stages

1. Establish a **safe source consistency boundary** (for example, a
   separately approved and reversible rewrite-disable procedure, or a
   trusted storage snapshot with equivalent guarantees). Inspect-only
   endpoint checks are not substitutes for that boundary.
2. Develop a controlled source capture operator and CI synthetic tests.
   Keep any backup output outside the repository in protected storage.
3. Independently attest provenance, archive integrity, backup custody
   and ability to access/decrypt the backup.
4. Replay **only the independent copy** in a networkless, portless,
   disposable Redis 8.4.8 container, with truncation rejection, and
   verify redacted P1/P2 structures against trusted source baselines.
5. Only after explicit production recovery sign-off, re-audit queue
   and PostgreSQL state and separately review Redis-only maintenance.

**Nothing in this PR authorizes a live Redis change, copy, restart,
ACL load, scheduler, job change or publication.**
