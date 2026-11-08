# P2-03 NOAA historical metadata projector: single DB-only attempt (code only)

**This PR does NOT authorize or execute a database write.** It depends on the
separately reviewed read-only admission in PR #463. Never run the operator
script until both PRs have merged and the operator has independently reviewed
the exact resulting GitHub main SHA, rights, the existing restricted login,
compiled Worker entrypoint, risk and current source/host and database state.

## Purpose

The operator's existing evidence at e17bff79331840f28ceecb5afb8f2919e11d0a05
shows 18 NOAA feed candidates, 10 correctly projected, 8 not projected.
All 8 match the SQL projector metadata selector, are older than 48 hours,
and none is eligible for the current editorial profile age window. Their
projection is historical persistence work, **not** a way to make P2-04
pass. Do not relax ranking thresholds or claim multi-source matching.

The script hardcodes source noaa_news, limit 8, one existing reviewed
immutable Worker image ID, the named
vns_feed_project_login_prod login and the existing restricted root-owned
secret file (UID 10004, mode 0400). It never polls a feed. It uses the
existing compiled feed-candidate-project-once.js and the guarded PostgreSQL
function vns.project_approved_feed_candidates. No Docker build or pull,
Redis, scheduler, egress, host port, public API or publisher key.

## Read-only preflight after BOTH PRs are reviewed and merged

    sudo bash scripts/p2_03_noaa_project_once_operator.sh \
      --preflight --expected-sha EXACT_REVIEWED_40_CHARACTER_MAIN_SHA

The nested script must return reviewable_no_write after checking the pinned
clean main, Git index ownership, image identity, healthy Compose database,
internal backend, zero competing workers, current signed source/host
and independent SQL-anchor witness, restricted projector login/secret,
and precise 18/10/8 no-conflict aggregate counts. The operator script
also refuses if its fixed audit marker already exists. A PASS is NOT
a permission to project or to repeat any historical NASA/NOAA GET.

## Separate one-time operator approval, never in CI

Only after separate owner approval of this exact DB-only mutation, pinned
image, fixed scope and the absence of competing workload, and after the
compiled entrypoint and data-loss/recovery posture are independently checked,
the operator may choose the following **single irreversible attempt**:

    sudo bash scripts/p2_03_noaa_project_once_operator.sh \
      --run --expected-sha EXACT_REVIEWED_40_CHARACTER_MAIN_SHA \
      --approval NOAA_HISTORICAL_DB_ONLY_PROJECTION_ONCE_NO_RETRY

Before Docker creation, the command reserves a root-owned 0700 audit
directory under /var/lib/videonews-studio. If anything later fails, the
marker remains; **no retry, no new name, no Docker restart, no cleanup**.
The fixed audit container vns-noaa-project-20261108-a5c73c9 is preserved
after completion, whatever its outcome. The image is addressed by SHA256
ID, runs without egress on the internal backend network, as UID 10004,
capabilities dropped, no host ports, with one password bind mount and
bounded CPU/memory/PIDs. Only the node DB-only entrypoint is started once.

The operator must preserve all prior NASA/NOAA audit containers, signed
checkpoints, Redis/BullMQ history, and PostgreSQL source records. No
transaction replay is implied by a failure. Existing IONOS backup
availability and Beszel installation are operator-attested, but isolated
restore and projector-specific alerts have not been verified; this script
does NOT create or assume a backup.

## After attempt: independent operator read-only verification

Run as ap (NOT root), with the exact merged SHA:

    python3 scripts/p2_03_projection_readonly_evidence.py \
      --expected-sha EXACT_REVIEWED_40_CHARACTER_MAIN_SHA --source-id noaa_news
    python3 scripts/p2_04_multisource_readonly_readiness.py \
      --expected-sha EXACT_REVIEWED_40_CHARACTER_MAIN_SHA \
      --source-ids nasa_news,noaa_news,usgs_news

Count projected articles/events, metadata conflicts, zero publication
violations; distinguish historical completeness from recent multi-source
readiness. Publisher provenance, authenticated Admin display, restart
behavior and peer review remain separate P2 production acceptance tasks.

**No approved independent publisher, claim verification or publication is
created by an otherwise successful one-shot process.**
