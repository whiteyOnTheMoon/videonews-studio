# P2-02 — Redis 8 offline AOF archive guard (preparation only)

## Confirmed VPS evidence

Release on `main`: `15f19b22b50a419184cfac663ad87c2c770ce5a2`.
Productive Redis: pinned `redis:8.4.8-alpine@sha256:d78b2cc0b2433837395263cb86d5ce3830f492201525b0fd148496706fc8fe8c`.
Active volume: `videonews-studio_redis_p109_restored`.
Historical volume: `videonews-studio_redis_data` (must be retained).
Read-only observation: AOF manifest 88 bytes, one base segment, one incremental segment,
three files total, AOF directory 8452 KiB, data directory 8464 KiB;
ext4 on `/dev/vda1` with approximately 11.8 GiB free.
No production volume, container, ACL, queue or database changes were made.

## Scope of this change

`scripts/p2_02_redis8_offline_archive.py` validates a pre-existing **offline
copy** of a multipart AOF directory. It checks strict manifest syntax,
referenced files, regular-file invariants, bounds, and SHA-256 contents.
It accepts the legacy six-field manifest lines and Redis 8.4's optional
`startoffset`/`endoffset` fields on incremental AOF entries, with strict
syntax, ordering, and bounds. It compares the copy with an inventory
supplied **by an independent custodian**.
Checksums and AOF bytes must never be printed, committed, or uploaded to CI.

The **offline validator** does **not**:
- read the live Docker volume, connect to Redis, issue a Redis command or copy data;
- make, seal, delete, rewrite or replace backups or volumes;
- prove the capture is point-in-time consistent or its inventory independently trusted;
- start Redis, replay AOF, verify credentials, inspect job payloads, or authorize a restart;
- implement an execution or rollback path for production.

The unit tests contain **only synthetic byte strings**. The separate
`ci_p2_02_redis8_offline_restore.py` CI rehearsal creates an isolated Redis
8.4.8 AOF fixture, stops its synthetic source, copies it to a separate
private directory, rejects a deliberately tampered copy, then starts only
the verified independent copy in a new container with `--network none`,
`--read-only`, no published ports and `--aof-load-truncated no`. It checks
synthetic P1/P2 completed entries and tears down the disposable CI objects.
This test NEVER reads a real Docker volume, and its source is fully stopped.
The CI replay is not evidence of consistency or recoverability of real VPS
data. No real credentials or job contents are used.


## CI-only paused capture alternative — NOT production authorization

The second CI rehearsal `ci_p2_02_redis8_paused_capture.py` deliberately pauses
**only a disposable synthetic Redis container**, copies the three-file AOF while
paused into another private directory, removes the synthetic source, then
replays only the independent copy without a network. It is a candidate for
avoiding the need to grant a live `CONFIG SET` ACL to a production identity.

A production Redis `docker pause` is **service-disrupting**, even if brief.
It can interrupt API, BullMQ worker connections, and job delivery. A future
live procedure must therefore include all of the following before execution:

- A verified, bounded pause duration, with an *independent unpause watchdog*
  installed, tested, and capable of recovering if the operator is interrupted,
  exits unexpectedly, receives SIGKILL, or loses its terminal.
- A production job/producer quiescence gate and explicit P1-worker risk review.
- A pinned, read-only source mount, new isolated destination and fail-closed
  metadata/persistence guards; no raw AOF bytes in logs or repository.
- Owner-only backup permissions, independent provenance custody and offsite
  recovery access verification.
- Replay in a separate Redis 8.4.8 instance, with trusted P1/P2 baseline
  comparisons and zero connection to the running Redis network.

The CI script's `finally` cleanup is **not** a crash-proof watchdog and does
not authorize this procedure on any VPS. An aborted or interrupted production
pause without an independent failsafe is unacceptable.

## Requirements before live capture and recovery acceptance

1. Separately implement and CI-test a root-controlled capture operator with the
   source volume mounted **read-only**, a fresh private destination outside the
   repository, and strict live-state/source-file stability checks. No retries.
   Redis's documentation recommends disabling AOF rewrite for a live backup.
   As we do not allow CONFIG SET on production, fail closed on any indication
   that a rewrite may have overlapped capture; a consistency claim needs
   independent review of this residual race.
2. Establish a verifiable consistency boundary. A self-generated checksum
   adjacent to a live copy is not independent evidence.
3. Record trusted provenance (exact source volume, release SHA, pinned image,
   capture interval, expected segments) in an independently protected inventory,
   and verify the resulting archive against that inventory. Never print hashes.
4. Ensure the archive and inventory have owner-only permissions, separate
   encryption/key custody as appropriate, and a recoverable off-host copy.
5. Use an **independent** disposable data copy for a networkless, portless Redis
   8.4.8 AOF replay. No workers, service networks or original production volume.
   Test complete replay with strict truncated-AOF rejection and verify bounded,
   redacted P1/P2 structural counts against a trusted baseline. Verify recovery
   access and ACL compatibility without logging passwords, ACL hashes or jobs.
6. Only after an explicit recovery sign-off re-audit the live queues and
   PostgreSQL and develop/review a separate Redis-only execution operator.

Official Redis documentation: https://redis.io/docs/latest/management/persistence/
The native Redis BACKUP family starts in Redis 8.10, not in pinned Redis 8.4.8.

**Status: OFFLINE VALIDATOR ONLY — NOT A PRODUCTION BACKUP OR RESTORE PERMIT.**
