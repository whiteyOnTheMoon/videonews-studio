# P2-03 NOAA historical projection — read-only admission gate (2026-11-08)

**Code and offline tests only. No production projector permission, DB write, new
feed GET, build, image pull, Compose start, scheduler, ranking bypass or
publication.** The eight missing NOAA articles were observed in the operator's
read-only production evidence at main e17bff79331840f28ceecb5afb8f2919e11d0a05.
All eight passed the projector's existing metadata selector, all eight were
older than 48 hours, and zero were age-eligible in the active editorial profile.

## Why another preflight?

The old P2-03 projector component is opt-in and can WRITE to PostgreSQL through
the narrow named vns_feed_project_login_* role. The Compose overlay still names
the unlabelled local tag vns-worker:local; it is **not** an acceptable production
identity merely because that image exists. The previously audited immutable
Worker image vns-p2-worker:a5c73c9ea5b8 has ID
sha256:0116ba447642645ae81324347ac800fd45991fdf7006676936d7515f285a45ef
and OCI revision a5c73c9ea5b8fba8a982e423c8eb5b5f42d48031.
The operator compared relevant Worker source and dependencies against the
current main and found no drift. This does NOT independently attest the
compiled JavaScript inside the image.

The preflight **only reads** Git, local Docker image/network/container
metadata, filesystem ownership/modes, signed-source SQL/anchor witness
and bounded PostgreSQL aggregate counters. It rejects changes in the
observed baseline: 18 NOAA candidates, 10 mapped, 8 unprojected/selectable,
all eight older than 48h, none in the editorial age window, zero metadata
collisions or scope blockers, 1 strictly restricted projector login,
zero publication violations and current NOAA source/host revision 10/10.
It also checks the pre-existing signed-source/anchor trust witness.
A changing baseline is NOT fixed by increasing limits or resetting leases.

## Operator command — only after review/merge and exact main synchronization

The existing script is for root-only metadata inspection. It never calls
Docker create/start/run, changes SQL, exposes a password, or runs Git status
without --no-optional-locks. Run with interactive sudo; pin the actual
reviewed merge SHA (do not use an unchecked dynamic HEAD):

    sudo python3 scripts/p2_03_noaa_projector_readonly_preflight.py \
      --preflight --expected-sha REVIEWED_MERGE_SHA

The only successful status is reviewable_no_write, and it always reports
projection_authorized=false. On refusal, stop and inspect. The root-owned
runtime secret must remain UID/GID 10004:10004 mode 0400. Never change Git
index permissions recursively; the index is expected ap:ap 0600.

## Next distinct approval gate, NOT implemented by this patch

Before any DB-only projector start, independently attest the actual compiled
image entrypoint, current source/host authority and role/secret custody, exact
requested source and limit, absence of competing projectors, backup/rollback
readiness, and a named operator's ONE explicit write approval. Any execution
must use the *immutable image ID*, UID 10004, readonly rootfs, internal backend
only, no host ports, bounded resources, mounted existing projector secret,
and no HTTP/Redis/Publisher credentials. Preserve any failed audit container;
no blind retry or projector replay.

Even if all eight old NOAA candidates project, this does **not** create fresh
cross-source evidence, a ranking row or a publication permit. P2-04 still
requires genuinely matching, time-eligible independent sources, separate
publisher provenance review and authenticated Admin acceptance. Preserve all
historical NASA canaries and queue jobs.
