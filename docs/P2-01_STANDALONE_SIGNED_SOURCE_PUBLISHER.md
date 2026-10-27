# P2-01 – Standalone signed source publisher (manual one-shot)

## Scope

The compiled `apps/worker/dist/feed-source-publish-once.js --once`
is a **dedicated entrypoint**. It is not imported by the normal worker, does
not start BullMQ, performs no HTTP feed fetch, and never publishes news.
It reuses the audited PostgreSQL source-export SQL function introduced in
migration 0034 and the existing Ed25519 fsync/rename file publisher.

The process exits unsuccessfully unless all operator gates, secret paths,
source host policy and PostgreSQL role attestation pass. It never creates a
signing key or database role and never updates source/host approvals itself.

The worker image **contains** the compiled command, but deployment is not
enabled or mounted in Compose. This is not a VPS rollout or production
publisher acceptance.

## Required operator-controlled configuration

All the following are required:

- `VNS_SOURCE_PUBLISHER_ENABLED=true`
- `VNS_SOURCE_PUBLISHER_OPERATOR_ACK=true`
- `VNS_SOURCE_PUBLISHER_RIGHTS_ATTESTED=true`
- `VNS_SOURCE_PUBLISHER_MODE=single_pass`
- `VNS_SOURCE_EXPORT_DB_HOST=postgres` (or `127.0.0.1` for isolated CI)
- `VNS_SOURCE_EXPORT_DB_USER=vns_source_export_login_<individually provisioned suffix>`
- `VNS_SOURCE_EXPORT_DB_PASSWORD_FILE=/run/secrets/vns_source_export_db_password`
- `VNS_SOURCE_EXPORT_SIGNING_KEY_FILE=/run/secrets/vns_source_export_signing_key`
- `VNS_SOURCE_EXPORT_DIRECTORY=/var/lib/vns/source-publisher`
- `VNS_SOURCE_EXPORT_APPROVED_HOSTS=` followed by an out-of-band operator-approved
  comma-separated list of at most five current hostnames; **no defaults**.

The private signing-key file must be regular, not a symlink, and readable by
the dedicated publisher UID while inaccessible to world and to group writers.
The signing key is an externally generated, individually protected Ed25519
private key; never add it to GitHub, the worker's inbox or an image.
The publisher directory must already exist, be owned by the process UID, have
mode 0700, and have no symlink replacement. File locks intentionally prevent
automatic post-crash recovery without operator review.

The database login must be nonprivileged, hold
`vns_source_export_reader` membership and EXECUTE on
`vns.read_approved_source_export()`, but **not** direct SELECT on the
source/host/audit tables or EXECUTE on the admin source mutation function.
A shared API/feed-worker DB identity does not qualify. The export login is a\ntechnical service identity, **not** a substitute for two independently\nauthenticated human source and host reviewers in the admin audit ledger.

## Security and operational limitations

- The process writes only its private signed export. A **separate secure
  transfer** must place a verified copy in the feed-observer inbox owned by
  the observer UID. Do not weaken directory ACLs or share signing keys to
  bypass the UID boundary.
- There is no automatic loop, queue scheduler, Docker publisher service or
  rollover/notification service in this increment. Do not schedule the CLI
  until deployment, lock recovery and alerts are independently reviewed.
- If a source approval is revoked and publication fails, the last signed
  export can remain on disk. This is **not** a fresh authorization. The
  observer's current PostgreSQL admission and guarded commit must reject
  revoked data; a race before already-started HTTPS remains unresolved.
- The configured approved host allowlist is a separate operator input, not
  generated from newly edited source records. Its real human rights approval
  and trust distribution require independent evidence before production.
- The new tests cover startup gating and identity privilege refusal. The
  existing signed publisher tests and isolated SQL-to-Redis integration
  cover crypto and data flow separately. No live signer/anchor/KMS or
  independent key-custody evidence is asserted.

## Operator release gates

Before ever enabling this binary on the VPS, review exact release commit
and digest, DB migration 0034, privately provisioned login and secret
permissions, separate publisher/observer UIDs, isolated bind mounts and
transfer, an independent signature/revision verification service, backup and
restore, monitor/alerts and a rollback plan that disables the publisher and
observer before restoring old DB role grants.

P2-01 and P2-02 stay open pending that controlled acceptance.
