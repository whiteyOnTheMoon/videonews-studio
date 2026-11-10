# P2-02: Read-only Studio status Redis ACL — code only

**Not a production change.** The read-only VPS inventory at the previously
deployed `d33612d629901e63713ffa2453446a9d8ee0d613` found five on-disk
Redis ACL users, with default off, feed producer and consumer present, but no
Studio status reader. The API image runs as `node`; no Studio producer/status
secret is mounted. GitHub `main` at the time of this proposal is
`a178caa93657251c69477a00c5ffad484db63056`.

The new `scripts/p2_02_studio_status_acl_custody.py` works only on a clean,
exact, operator-pinned `main` checkout under UID 1000 and a healthy
non-host-published Redis Compose container. It never executes Redis commands,
edits BullMQ jobs or checkpoint files, deploys Docker images or fetches feeds.

## Exact new ACL role

One new account: `vns_feed_status_studio`. Existing five ACL user lines are
preserved byte-for-byte. The new account is configured with `-@all`,
`resetchannels`, `+zscore +hget +exists` for the API's four fixed reads,
plus `+ping +quit` for connection lifecycle. Allowed keys only:

- `bull:vns:feed:vns-feed-poll:completed`
- `bull:vns:feed:vns-feed-poll:failed`
- `bull:vns:feed:vns-feed-poll:vns-feed-tick-*`

No access to `wait`, `active`, `events`, arbitrary key scans, writes,
scripts, the research/probe/provider queues, Redis administration or pub/sub.
This account cannot enqueue or consume BullMQ jobs.

## Operator phases — each mutation separately authorized

- `--preflight --expected-sha SHA`: **read-only**. Requires the exact
  baseline five on-disk users and a missing private Studio status directory.
- `--prepare --expected-sha SHA`: requires separate approval
  `VNS_P2_STUDIO_STATUS_ACL_PREPARE_APPROVED=CREATE_PRIVATE_STUDIO_STATUS_ACL_CANDIDATE_ONLY`.
  Creates a unique random status password and a byte-exact candidate ACL
  in `secrets/p2-studio-status-redis-acl/` (0700; all files 0600).
  It never alters the host ACL file or running Redis. Pre-existing or partial
  directory contents are refused, never overwritten.
- `--verify --expected-sha SHA`: **read-only**. Compares private credential,
  candidate and original ACL digest with current on-disk baseline.
- `--install-file --expected-sha SHA`: **separate future approval** via
  `VNS_P2_STUDIO_STATUS_ACL_INSTALL_APPROVED=INSTALL_STUDIO_STATUS_ACL_HOST_FILE_ONLY_NO_REDIS_RELOAD`
  and
  `VNS_P2_STUDIO_STATUS_ACL_RECOVERY_VERIFIED=OPERATOR_VERIFIED_OFFHOST_BACKUP_AND_ISOLATED_RESTORE`.
  Re-checks clean `main`, origin SHA, health, no Redis ports, exact file
  inode and baseline; saves 0600 baseline in private custody; atomically
  replaces only the 0644 **host** `secrets/redis_acl` file.
  **No ACL LOAD, Redis restart or container recreation.**
- `--installed --expected-sha SHA`: **read-only**. Checks saved baseline,
  candidate and installed host ACL byte-for-byte.

No action except preflight/verify/installed should be invoked until its own
explicit operator approval. A failed or ambiguous mutation must be inspected
read-only: **never blindly retry**. Never copy password files, hashes, private
ACL candidates or live container environment into chat or GitHub.

## Distinct future runtime acceptance

Adding an ACL user to the **host file** does not activate the role in the
existing Redis server; an already-bound Docker secret may reference the
previous inode. The live Redis-only recreation requires a separate proposal,
backup/restore proof and approval. Existing AOF, five ACL identities, Redis
volume, jobs and private media must survive. The Studio API will require its
own secret mounted as `/run/secrets/vns_studio_feed_status_password`, with
correct ownership and mode readable by the `node` process. A separate
producer identity/handoff and exact consumer mounts must be checked
independently before any Studio enable flag changes.

CI verifies the complete offline candidate lifecycle and tests the _actual_
generated ACL command and key scope on disposable Redis. Neither this PR nor
its tests authorize a live feed, candidate projector, ranking, rendering,
publication or Web/API deployment.
