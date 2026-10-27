# P2 signed-source Docker overlay – operator release contract

This overlay replaces the older `compose.feed-observation.yaml` scaffolding.
It is NEVER included with the default `docker compose` command. Its three
independent profiles are `source-signing`, `source-handoff` and
`feed-observation`. All application admission flags default to `false`,
no repeat/scheduler is introduced, no host ports are published, and the
existing production VPS is unchanged.

## Separate identities and networks

| Container               | Linux UID:GID | Network               | Responsibility                                                          |
| ----------------------- | ------------- | --------------------- | ----------------------------------------------------------------------- |
| `source-publisher`      | `10001:10001` | internal backend only | Signed SQL snapshot; sole process with Ed25519 PRIVATE key              |
| `source-handoff-import` | `10002:10002` | **none**              | Verify signed read-only staging into private inbox                      |
| `feed-observer`         | `10002:10002` | backend + feed egress | Verify remote revision anchor and observe a SINGLE authorized feed pass |

All images use the compiled worker target, but no application publishing API.
Each service has immutable root filesystem, dropped capabilities,
no-new-privileges, non-root user, no auto restart and bounded resources.

Every bind requires a **pre-existing host path** with
`bind.create_host_path: false`; no auto-created directories, no
world-readable shared storage and no private key shared into the observer.

## Host ownership requirements before any trial

These are infrastructure paths provisioned via operator-controlled deployment,
not news providers, secrets or mutable admin editorial settings.

- `VNS_P2_PUBLISHER_DIR`: 0700, owner UID 10001
- `VNS_P2_SIGNER_DB_PASSWORD_FILE`: regular 0400, owner 10001
- `VNS_P2_PRIVATE_SIGNING_KEY_FILE`: regular 0400, owner 10001
- `VNS_P2_HANDOFF_STAGING_DIR`: 0750, **separate transfer principal** as
  owner, GID 10002; mounted read-only into importer
- Staged `source-export.signed.json`: regular 0640, owned by the separate
  transfer principal and group 10002, no symlinks or additional hard links
- `VNS_P2_WORKER_INBOX_DIR`: 0700, owner UID 10002, read/write only to
  importer, read-only mount for observer
- `VNS_P2_WORKER_CHECKPOINT_DIR`: 0700, owner UID 10002
- `VNS_P2_PINNED_PUBLIC_KEY_FILE`: operator-pinned Ed25519 public key,
  readable by UID 10002; NOT taken from untrusted signed export
- `VNS_P2_ANCHOR_DB_PASSWORD_FILE`: 0400, owner UID 10002
- `VNS_P2_ANCHOR_CA_FILE`: private/trusted CA file readable by UID 10002
- `VNS_P2_FEED_DB_PASSWORD_FILE` and `VNS_P2_FEED_REDIS_PASSWORD_FILE`:
  regular files readable only by UID 10002, not from the signer

The Docker bind mount options do NOT create or guarantee these permissions.
A deployment preflight must verify them, including ownership, inode types,
mount point stability, read-only staging and distinct _real_ Linux UIDs.
The signed artifact must be transferred from the publisher output to
staging by a separately authorized, restricted principal. That transfer is
not silently accomplished by a shared volume or by this overlay.

## Manual operational ordering (NOT permission to deploy)

1. Operator inspects actual VPS resource use, service inventory and backups;
   verifies separate high-water anchor, TLS certificate, recovery drill and
   source/host human approval including rights.
2. Operator pins release image digests and validates all host file ownership.
3. Independently provision source exporter DB login, separate human approvers,
   publisher private key and observer public verifier.
4. Only with exact plan approval, run `source-signing` profile once and
   verify the exported signature/version in a private signer directory.
5. Move the signed artifact into staging with the separately reviewed
   transfer principal. Trigger `source-handoff` profile once.
6. Verify importer wrote a 0600 private signed file; no network traffic
   originated from importer. Confirm high-water trust service separately.
7. Only after separate operator approval, run `feed-observation` profile
   for **one** event (not cron), with current rights and allowlist gates.
8. Inspect PostgreSQL metadata, Redis queue and audit; stop at any warning.

Do not activate a real news source, continuous scheduler, paid provider or
editorial release through this procedure. Build success alone is not an
operator approval and cannot substitute for a restore/alert test.

## CI and remaining blockers

`scripts/test_p2_feed_compose.mjs` proves the three opt-in profiles,
numeric UID separation, restricted networks, offline importer, fail-closed
gates and exact immutable mount map. The existing real Redis/PostgreSQL
suite and Docker probe tests still run. No production owner/permission
preflight, true distinct-UID filesystem integration test, private transfer
daemon, independent PostgreSQL anchor disaster recovery, signature key
rotation, end-to-end editorial approval or VPS acceptance is claimed.

An offline static overlay inspection is not proof that filesystem ownership,
credential provisioning or TLS-reachable anchor exist on the actual VPS.
No P2 issue should be closed on this PR alone.
