# P2 signed-feed host preflight – read-only UID/ACL gate

This change adds `scripts/p2_feed_host_preflight.py`. It is a **read-only**
release inspection tool, not a provisioner. It performs `lstat` of pre-existing
host paths, checks canonical absolute paths, file/dir types, owners, numeric
UIDs/GIDs and exact permission bits. It does **not** open any file contents,
create or fix a permission, modify Docker or PostgreSQL, connect externally,
copy a signed export or reveal any secret path in its JSON output.

## Operation

The host operator supplies the eleven `VNS_P2_*` bind-mount variables from
the current signed Compose deployment contract, plus a separate
`VNS_P2_TRANSFER_UID` (a dedicated real non-root account with numeric UID
between 10003 and 60000). `10001` is reserved for the signing publisher,
`10002` for the signed-importer/observer. No username is substituted for
these numeric identities. All host paths must already exist.

After a separately authorized, read-only VPS inspection, the operator may
invoke as root with an approved environment:

```bash
python3 scripts/p2_feed_host_preflight.py --phase prepare
python3 scripts/p2_feed_host_preflight.py --phase handoff
python3 scripts/p2_feed_host_preflight.py --phase observer
```

The sequence represents **different moments**, not three commands to run
unconditionally:

- `prepare`: before approving the publisher's first run. Checks signer
  0700 private directory, 0400 signer key/DB secret, transfer staging 0750,
  worker 0700 inbox/checkpoint, worker DB/Redis/anchor secrets 0400, and
  operator-owned pinned Ed25519 public key and TLS CA 0440 (UID 0, GID 10002).
- `handoff`: after a separately authenticated transfer principal has
  staged the signed `source-export.signed.json`. Adds mode 0640, GID 10002,
  owner `VNS_P2_TRANSFER_UID`, single-link and byte-bound assertions.
  Can be a prerequisite for the **first** observer activation.
- `observer`: after a signed observation has actually established and
  persisted the first independent high-water approval and local worker
  checkpoint. Adds private 0600 inbox export and checkpoint checks. It cannot
  prove the initial checkpoint exists before the first accepted observation.

CLI requires root for complete protected-secret metadata access. A success
returns generic JSON (`status=pass`, phase and number checked). Any missing
path, unexpected permission, symlink, wrong UID/GID or invalid stage returns
`status=blocked` with exit code 2, no paths, usernames, keys or tokens.
Never copy secret values to CI, GitHub Issues or chat.

## Security and trust limits

This preflight checks **host-side metadata only**. The separate
`scripts/test_p2_feed_compose.mjs` confirms profile/mount/network design,
and the real worker independently verifies the pinned Ed25519 signature and
external monotonic PostgreSQL anchor. No single local check is an independent
authenticity claim. Manual operator validation still must inspect the actual
running Docker mounts, effective container UIDs, host parent directory and
ACL inheritance, filesystem/mount replacement risks, user namespace mapping,
backups, recovery, DB TLS and trusted independent anchor custody.

A world-readable signed export or signing key is _never_ a workaround. If the
permitted host modes differ, revise the vetted deployment design and tests
rather than bypassing checks. The source transfer principal and externally
held signature key still require independent enrollment and human approval.

Beszel remains the established **server-level monitoring** service
(`docs/P1-09_BESZEL_MONITORING.md`). This preflight neither registers a
Beszel alarm nor proves a live alert delivery; the operator must witness
that delivery during an approved rollout.

The associated CI runs synthetic stat-based negative tests only. It never
provisions a real host user or runs the preflight against an actual VPS.
P2-01/P2-02 remain open and the live deployment is not authorized by these
files alone.
