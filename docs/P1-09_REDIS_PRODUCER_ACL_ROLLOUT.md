# P1-09 – Additive Redis ACL for the existing production Redis 7

**Operator-reported current production facts (2026-10-28):**
- PostgreSQL 48/48, dedicated `vns_provider_outbox_login` installed.
- 32-byte prompt key independently stored in both API and producer directories,
  byte-for-byte verified without symlinks or hardlinks.
- Active Redis user names found **on disk**: `default`, `vns_worker`.
- No Redis producer ACL has been installed. No Redis container has been
  restarted and no provider spending has been authorized.

## Strict phases

`scripts/p1_09_redis_producer_acl_rollout.py` acts on the host **only**.
It never runs Redis commands or restarts a container.

1. `--preflight`: read only, requires a clean, current main checkout, operator
   UID 1000, securely owned `secrets` and `secrets/vns-outbox` directories,
   a regular 0644 original `secrets/redis_acl`, an unchanged password-hashed
   producer ACL candidate and existing default-off/worker-on accounts.
   It refuses an already-present producer user or another existing staging
   file. Existing additional Redis users are allowed and preserved verbatim.
2. `--prepare`: create **only** two private 0600 files under
   `secrets/vns-outbox`: `redis-acl-with-producer` and
   `redis-acl-baseline-sha256`. No change to the active or on-disk Redis ACL.
3. `--verify`: re-read both files and require exact match with the
   still-unchanged original ACL. This refuses competing edits, duplicate
   producer entries and an unsafe producer candidate.
4. `--install-file`: requires an **independent explicit operator-approved**
   environment guard `VNS_P109_REDIS_ACL_FILE_INSTALL_APPROVED=
   INSTALL_PRODUCER_ACL_FILE_ONLY` and a full, exact `main` SHA pin in
   `VNS_P109_REDIS_ACL_EXPECTED_SHA`. Preserve the previous ACL in the
   private 0600 `redis-acl-before-producer` file, fsync a new 0644
   host file and atomically replace `secrets/redis_acl`. If the old file
   changed even during staging, refuse to replace it. **No Redis live change
   occurs during this command.**
5. `--installed`: read-only confirmation that the original ACL is fully
   preserved in the backup and the newly installed file is exactly the old
   bytes plus one restricted producer user.

## Exact-state recovery after a failed ACL file installation

The VPS operator invokes deployment shells with `umask 077`. In the original
implementation, `safe_create(..., mode=0644)` did not override the process
umask, so the atomic host ACL replacement could succeed with mode `0600`.
The final `--installed` read-only check then correctly refused the
nonconforming mode, reporting a generic failure **after the rename**.
No Redis restart or ACL reload is performed by that helper.

**Do not retry `--install-file`, regenerate passwords, delete the backup,
run `chmod` manually, or restart Redis when this happens.** First inspect,
read-only and without printing ACL contents or hashes: the host file mode,
private saved original/merged candidate modes, presence of the pending
temporary file, and whether the host bytes match the original or merged
candidate. The cases are intentionally different:

- Existing host file still `0644` and equals the original: no installation
  occurred; any newly created backup/temporary file needs separate manual
  review, and the original install command must not be blindly repeated.
- Existing host file `0600`, exactly equals the *fully installed* merged
  candidate; original saved backup and baseline hash match; no pending temp:
  only then may a separately SHA- and operator-approved
  `--repair-installed-mode` correct the already-installed host inode to
  `0644`. This command reads and verifies all bytes and identities through
  no-follow file descriptors; it **changes only the permission mode**, not
  the ACL content, running Redis, users, volumes or jobs.
- Any other state (missing backup, different bytes, a temp file or unexpected
  modes): stop and perform a manual read-only investigation before changes.

Required repair-specific approval:
`VNS_P109_REDIS_ACL_MODE_REPAIR_APPROVED=
REPAIR_INSTALLED_0600_TO_0644_ONLY`, plus the matching full main SHA in
`VNS_P109_REDIS_ACL_EXPECTED_SHA`. A normal `--installed` must succeed
after the repair. Treat it as a one-off recovery, not an idempotent retry.
The regular future installation now calls `fchmod` on newly created files
before the atomic rename; CI reproduces the operator's restrictive umask.

## Why a live Redis restart is a separate, controlled operation

The existing `vns_worker` user is denied Redis administrative commands
(`-@admin`, `-@dangerous`). It cannot call `ACL SETUSER`, `ACL LOAD`
or `ACL SAVE`. The baseline `default` Redis user is disabled.

Docker Compose mounts the host `secrets/redis_acl` as a read-only secret.
The file installation uses an *atomic rename*: the already-running Redis
container may still hold the **old inode**. Its effective ACL does not
change until the container is recreated. Never infer runtime ACL status
from the host file, and never attempt `docker kill`/`docker restart` or
`ACL LOAD` as a shortcut.

Only after a separate read-only runtime/volume/network/active-session
preflight should the operator issue a controlled, **Redis-only** Docker
Compose recreation using `--no-deps`, `--no-build` and the already
reviewed Redis image. The existing `redis_data` AOF volume must be retained,
and `postgres`, `api`, `web`, `worker` must not be recreated.
Transient Redis unavailability and worker reconnection must be expected.
The current IONOS backups and Beszel monitoring are operator-confirmed.

After recreation, authenticate separately as `vns_worker` and
`vns_provider_producer` without ever echoing passwords. Verify `default`
remains disabled; existing jobs/keys remain; the producer can access only
`bull:vns:vns-provider-text:*` and cannot access `bull:vns:vns-jobs:*`,
issue `FLUSHALL` or manage Redis ACL. Capture only sanitized PASS/FAIL,
not ACL password hashes, prompts or credentials.

If Redis fails after recreation, **do not blindly retry or erase AOF**.
Preserve service logs without secrets, check volume and config, and plan
restoration from the privately saved original ACL with a separately
approved file installation and container recreation. Do not delete a
published job: Redis receipt/idempotency audits depend on retained jobs.

No migration, API-provider request, budget enablement, queue consumer or
producer invocation is performed by this stage. The producer will remain
disabled until its own digest-pinned image and single-pass production tests
have been separately accepted. This rollout is not a Phase-1 final acceptance.

## CI proof

`.github/workflows/p1-09-redis-producer-acl.yml` uses **only ephemeral
synthetic passwords** and a disposable `redis:7-alpine` instance with no
network attachment. Unit tests prove refusal on ACL changes, symlinks,
duplicate users and missing approval; the real container test confirms the
existing worker identity still works, the new producer can authenticate
and use its own namespace, and cross-queue/admin commands are denied.

GitHub CI success is not proof of the real VPS Redis restart or producer
runtime behavior.
