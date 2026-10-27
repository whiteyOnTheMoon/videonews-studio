# P2-01/P2-02: Signed source handoff import (manual, disabled)

## Implemented boundary

`source-handoff-import-once --once` is an independent compiled Node.js
entrypoint. It does not require or receive the publisher private signing key,
PostgreSQL credentials, Redis credentials, outbound networking or editorial
publishing credentials. No scheduler or Docker service starts it by default.

After an operator-approved transfer **into a read-only staging mount**, it:
1. Refuses every operation unless the manual enable/ack and exact paths match.
2. Reads the staged file through `O_NOFOLLOW` and requires a canonical
   directory, a file with exactly one hard link, no world access, group
   *read-only* access and no group-write permission.
3. Requires the staged directory to be traversable and readable to the
   importer's dedicated group but not group-writable or world-accessible.
4. Verifies the envelope's Ed25519 signature with a separately provisioned,
   pinned **public** key and the current independently approved host list.
5. Rejects source- or host-revision rollback and different contents at an
   identical revision pair, relative to the existing signed worker inbox.
6. Uses an exclusive lock and `fsync` + atomic rename + directory sync to
   write a private, worker-owned, mode-0600 signed file into the 0700 inbox.
   Stale locks require explicit human recovery.

This importer **does not release sources for network use**. The live
`feed-observe-once` process still calls `acceptDormantSourceFile`, which
checks the separate PostgreSQL high-water authority and advances the private
worker checkpoint before returning any feed source.

## Required manual configuration

- `VNS_SOURCE_HANDOFF_ENABLED=true`
- `VNS_SOURCE_HANDOFF_OPERATOR_ACK=true`
- `VNS_SOURCE_HANDOFF_MODE=single_pass`
- `VNS_SOURCE_HANDOFF_STAGING=/var/lib/vns/source-handoff`
- `VNS_FEED_SIGNED_SOURCE_INBOX=/var/lib/vns/feed-source-inbox`
- `VNS_FEED_SOURCE_PUBLIC_KEY_FILE=/run/secrets/vns_feed_source_public_key`
- `VNS_SOURCE_FETCH_ENABLED=true`
- `VNS_ALLOWED_SOURCE_HOSTS=` with human-approved exact HTTPS hostnames

No values in this document constitute approval for real news sources or
network access. A policy parse during import makes no HTTPS requests.

## Trust and UID separation

The **host operator** must create the staging area and transfer a signed
artifact from the publisher-owned 0700 output using an independently
reviewed, restricted transfer process. Never mount the private publisher
directory directly into the consumer. The importer should see only a
read-only staging bind mount, mode 0750, with the importer's **dedicated**
GID and a single mode-0640 file. Staging must be operator-owned or owned by
a distinct transfer UID; no file may be writable by the importer group.

The consumer private inbox must be writable only to its separate UID with
mode 0700. The consumer gets the public verifier, never the signing private
key. Source transfer integrity follows from the cryptographic signature,
not merely the host copy or a local file hash.

There is **no provisioned transfer daemon, Docker ACL, independently
authenticated artifact transfer, cross-UID OS acceptance test, or
continuous reloading** in this change. The tests use synthetic fixtures
under one disposable CI UID; they prove safe file modes, signature
validation, replay refusal, hardening and basic atomicity, but do **not**
claim an independent production trust boundary.

## Production blockers

Before rollout: design and approve the actual transfer principal, GID/ACL
model and read-only mount; test it with distinct real Linux UIDs; enforce
host path ownership and directory inode pinning against mount replacement;
independently provision the anchored PostgreSQL high-water service, its
recovery and the trusted Ed25519 public key. The publisher process must
also be connected to the admin DB with audited, independently approved
sources. Do not auto-import a new export on feed scheduler ticks without
bounded alarms and explicit operator approval.

Even a valid signed export may be stale following revocation. Guarded SQL
from migration 0033 is the final DB-write gate, and a separate revocation
window exists for HTTP requests in progress. This increment does not
resolve it, automate a scheduler, or modify the VPS.
