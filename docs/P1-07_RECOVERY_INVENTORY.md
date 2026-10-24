# P1-07 — Repository-backed recovery component inventory

**Status: planning evidence only. No live VPS inspection, backup or deployment approval.**

The versioned [recovery inventory](p1-07-recovery-inventory.json) contains **22
components** that must be considered before a complete VideoNews Studio
recovery. Each entry has a concrete repository source file and an exact
non-secret text anchor, a recovery strategy, dependencies and one of the
14 recovery-runbook steps. An automated GitHub-only test checks these
references and fails if a listed prerequisite disappears from the
repository without an explicit review.

This is **not a scan of the running VPS**. `compose.yaml` is a design
scaffold with opt-in `data`, `worker` and `ingress` profiles.
Real containers, Cloudflare Tunnel settings, actual databases, their
size, age and location, installed media services and operator accounts
may differ. The repository is not allowed to infer they are present,
healthy, backed up, recoverable or approved.

## Recovery disposition

**Rebuild from source:** Git-tracked application code, container image
definitions, Compose scaffolding and Caddy's checked-in reverse proxy
configuration. Actual image digests, independent build dependencies,
registered domain/tunnel integration and uncommitted deployment
configuration still need operator verification. Source in GitHub
cannot replace missing stateful database volumes.

**Must have an independently verified data backup:** PostgreSQL
application contents, PostgreSQL global roles and role memberships,
Redis multipart AOF/queue persistence, and editorial/audit ledger
records. The table records may also belong to the PostgreSQL volume:
the inventory tracks this _logical requirement_, not a claim that
these are four independent physical files or backups.
The CI restores synthetic PostgreSQL and Redis fixtures, but there
is **no approved real off-host copy**.

**Reissue/reconfigure with operator supervision:** PostgreSQL and
Redis service passwords and ACL configuration, administrator password
hash, environment settings and attributable operator/database
logins. Rotating application credentials does not re-create missing
review history or revoke credentials on other hosts automatically.

**Recover from independent custody, NOT merely rotate:** decryption
keys for older encrypted backup archives and previously trusted
signature-verification roots/key history. Generating a new random
decryption key makes historical archives unreadable. A new signing
key does not independently authenticate older ledgers or forgive
a rollback; key revocation and freshness evidence must be maintained
outside the archive.

**Operator verification required:** actual Cloudflare Tunnel
credentials/routes, DNS/domain control, external publisher
authorizations, separate offsite signed audit archives and the
PostgreSQL–BullMQ reconciliation boundary. The current Git repository
does not prove recoverability of any of them. They must not be
automatically exported to a CI artifact.

**Not yet configured:** a durable uploaded-media service and its
rights/license metadata. There is currently no confirmed configured
media volume in `compose.yaml`. Future media storage must gain
an independent checksum/recovery strategy before publication features
are approved. The inventory must not silently claim that a nonexistent
backup has been made.

## Status, evidence and change control

Every component is marked:

- `operatorVerified=false`
- `offsiteBackupVerified=false`
- `isolatedRestoreVerified=false`
- `approvedCustodian=null`
- `backupLocation=null`
- `evidenceReference=null`

These are intentional unknowns, **not evidence that the real server
contains no state**. The inventory itself has
`productionInventoryVerified=false`,
`backupDestinationApproved=false` and `activationApproved=false`.
An approved future design must introduce an independently
authorized, appropriately protected evidence register; it must not
simply flip these flags based on a GitHub build.

The GitHub Actions test `scripts/test_recovery_inventory.mjs`
validates all 22 exact IDs, data dispositions, file/anchor references,
known recovery-step IDs, component dependency DAG, and absence of
claims about approved locations, custodians, backups or restore
success. Adversarial tests remove components, alter source paths,
hide PostgreSQL/Redis requirements, claim nonexistent media backups,
invent a custodian or storage destination, and treat old decryption
keys as freely replaceable. Every such case is rejected.

**Operational prerequisites remain unchanged:** operator-selected
external backup destination and budget, retention/privacy approval,
real off-VPS restored copies, independently held decryption and
signing keys, Cloudflare and publication credential recovery,
media/integrity verification, Redis/PG queue reconciliation and
explicit production authorization. All twelve P1-07 release gates
remain closed. Nothing in this inventory accesses or alters
the running VPS, DNS, Cloudflare, PostgreSQL, Redis, existing
Admin login, Docker containers or user identities.

See the [full recovery runbook](P1-07_RECOVERY_RUNBOOK.md) and
[cryptographic custody design](P1-07_BACKUP_KEY_CUSTODY.md).
