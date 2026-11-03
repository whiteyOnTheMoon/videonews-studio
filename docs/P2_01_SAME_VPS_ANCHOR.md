# P2-01/P2-02 – One-VPS PostgreSQL source anchor (explicit opt-in)

## Simplified deployment and limitations

The existing PostgreSQL 17 container and its `videonews` database may hold a
separately permissioned `vns_source_anchor` schema. This needs **no** new server,
container, network, public port or offsite service. It is an expressly selected
alternative to the previous external TLS authority, **not** the default.

The separate `vns_anchor_login_*` PostgreSQL account still receives only
schema USAGE and two SECURITY DEFINER function EXECUTE rights. It must never
own those functions, read or write the high-water/preapproval tables directly,
inherit the authority-owner role, or receive application writer privileges.
A manually approved Ed25519 key, signed source export, checked source/host
revisions, pinned policy digest and the worker's private checkpoint remain
mandatory. Existing source, host and audit registrations are unchanged.

**Known tradeoff:** VPS root, the PostgreSQL DBA, the shared volume and a
complete IONOS restore can roll back the anchor together with application
state. This is not independent anti-rollback, cannot resist a compromised VPS,
and must never be described as such. After a restore, keep feed services OFF
until the signed export, SQL revisions, key policy and checkpoint have been
personally reconciled. Existing IONOS backups and Beszel stay as accepted.

## Exact opt-in runtime configuration

Only after the separate manual SQL setup and operator approval:

```text
VNS_FEED_ANCHOR_PLACEMENT=same_vps
VNS_FEED_SAME_VPS_RISK_ACK=ACCEPT_SHARED_POSTGRES_AND_RESTORE_DOMAIN
VNS_FEED_SOURCE_ANCHOR_HOST=postgres
VNS_FEED_SOURCE_ANCHOR_USER=vns_anchor_login_<approved_suffix>
```

The worker selects database `videonews`, host `postgres:5432` on the
internal Compose `backend` network and password-authenticated SCRAM
transport (no TLS on that private link). Any external hostname or missing
exact risk acknowledgement is refused. The existing `separate_tls` mode
remains the default and continues to require a separately pinned TLS CA,
valid remote DNS name and verified server identity; it rejects the local
risk acknowledgement.

The existing Compose overlay conservatively retains the mandatory
`VNS_P2_ANCHOR_CA_FILE` bind even in local mode. Local runtime never reads
that unused mount; it may bind the **existing root-pinned public-key file**
there to avoid creating a needless second certificate file. This is not
authorization to substitute an Ed25519 key for a TLS CA in external mode.

Every independent feed/queue/rights/operator enable switch stays OFF.
Nothing in the mode selection authorizes an actual feed request or publishes
news.

## Manual, one-time authority setup on the same database

These are **operator-controlled steps**, not commands to execute on merge.
Do not install a second PostgreSQL server or change the existing data volume.

1. On the already reviewed clean GitHub release, inspect the existing
   `videonews` database for `vns_source_anchor` objects and named anchor
   login(s). Existing rows must be inspected and reconciled, **never**
   dropped, reset or silently overwritten.
2. If absent, with separate explicit DBA approval, install authority SQL
   `db/independent-anchor/001_high_water.sql` through
   `004_preapproved_trust_policy.sql` into the existing `videonews`
   database, **not** through normal `db/migrations`. These older SQL files
   were originally documented for external use only; same-VPS application
   requires the operator to accept the shared restore-domain limitation.
   Provision a distinct NOLOGIN authority owner of all three tables and
   both SECURITY DEFINER functions.
3. Independently match the existing root-only signed-export candidate to
   personal source/host audits and reviewed publisher usage rights.
   Bootstrap exactly one `source-export` high-water row, one signing-policy
   high-water row and one identical policy preapproval row, all in a
   privileged audited DBA transaction. No worker is allowed to insert them.
4. Create a separate SCRAM-authenticated `vns_anchor_login_*` with a new
   long random password kept outside Git and chat. Grant only schema USAGE,
   the two function EXECUTE privileges and CONNECT; explicitly deny
   direct table operations, role inheritance and application writes.
   Mount its password **only** into observer/scheduler/consumer as a
   worker-owned 0400 file. Producer never receives that secret.
5. In a read-only DBA session, use
   `db/independent-anchor/operator_readonly_attestation.sql` with
   `expected_database=videonews`, the personally reviewed revision/hashes
   and runtime login. Test revoked/wrong login, wrong policy digest and
   no table-writing grants. No host PostgreSQL port may be published.
6. Authorize **one** `single_pass` feed observer only after source rights
   have been personally confirmed. Let the validated runtime create the
   first worker checkpoint after successful SQL high-water admission.
   Review candidates, projection, ranking and authenticated Admin view
   before considering any persistent scheduler.

The 2026-11-02 read-only VPS inventory showed source revision 8, host
revision 7, three approved sources, three host grants, a valid staged
signed export and a still-absent worker checkpoint. These are **observed
values**, not permanent defaults, legal licenses or automatic SQL seeds.

## Release scope

The GitHub change only makes the one-VPS connection selectable and tested.
It does **not** create PostgreSQL objects/roles, deploy an image, alter
source or host records, configure feed secrets, create a checkpoint, open
network access, activate providers or start services.
