# P2-02 – NOAA single metadata canary, operator-only (2026-11-08 UTC)

**This is not a standing feed permission, a copyright grant, or authorization
to project, publish, crawl other sources, use media or start a scheduler.**
Production is controlled by the person running the command on the VPS.
No CI test will start a real feed.

## Verified state before this PR

The operator's production read-only checks at clean main
448662c3a7f87efd669b6097dbcb1c7d4bc3bae0 confirmed:

- Signed source stage and Worker inbox byte-identical, source/host
  registration 10/10, current host grant, SQL high-water digest and
  trusted key policy matching. Status parity_reviewable. The full
  registry can contain sources beyond the approved-host signed subset.
- NOAA source approved, 60-minute poll lease already due since
  2026-11-04T00:21:23.535625Z; ten historically projected NOAA
  articles/events, none in the active editorial age window.
- Redis producer/consumer ACL isolated, distinct credentials, zero pending
  or running jobs, free current and previous 15-minute slots. Six failed
  and two completed historical jobs remain preserved. Status reviewable.
- Existing local Worker image tag vns-p2-worker:a5c73c9ea5b8 has
  image ID sha256:0116ba447642645ae81324347ac800fd45991fdf7006676936d7515f285a45ef
  and OCI revision a5c73c9ea5b8fba8a982e423c8eb5b5f42d48031.
  Its source implements the explicit NOAA single-pass selector.

These are point-in-time facts, not a permanent authority token.

## Official NOAA rights context

NOAA explicitly lists https://www.noaa.gov/rss.xml as a site feed for
RSS readers at https://www.noaa.gov/rss-feeds .
NOAA explains the ordinary public-domain status of its own information,
the need to credit NOAA and to separately respect third-party copyright
and usage restrictions:
https://www.noaa.gov/office-education/outreach-communication/faq .

The operator's separate test permission covers exactly one NOAA-only
metadata poll: up to 128 KiB uncompressed body, at most 20 metadata
candidates, one isolated BullMQ job, any required bounded PostgreSQL
lease and candidate writes. No NASA or USGS request, no image acquisition,
no new license assertion, no profile threshold change and no publication.

## Run only after this reviewed PR has merged and GitHub main is synced

From a clean VPS main checkout, replace REVIEWED_SHA below with the exact
40-character newly merged commit. The protected checks run as root using
interactively authorized sudo. Run the *read-only* preflight first:

    sudo bash scripts/p2_02_noaa_one_shot_operator.sh \
      --preflight --expected-sha REVIEWED_SHA

The preflight verifies Git main/commit, immutable Worker image, protected
mount ownership, internal backend plus dedicated egress network,
publisher signature/stage/inbox/checkpoint/10/10 SQL anchor, current
source/host grant, current metadata-only NOAA URL and 60-minute lease,
separate authenticated Redis ACL and queue with free current/previous
slots and historical job counts. No Docker create, no HTTP, no claims or
Queue writes happen in preflight. Refusal: stop, inspect only.

After a passed preflight, if the narrow operator permission is still
valid and the source rights unchanged, run the ONE authorized mutation:

    sudo bash scripts/p2_02_noaa_one_shot_operator.sh \
      --run --expected-sha REVIEWED_SHA \
      --approval NOAA_SINGLE_METADATA_POLL_ONCE_NO_RETRY

Run mode repeats every read-only check, creates exactly one fixed-name
container vns-noaa-single-20261108-a5c73c9 with a pinned image ID,
isolated UID 10002, drop-all-capabilities, readonly rootfs, no host ports,
bounded memory/CPU/PIDs, non-restarting policy, exact existing secret
mounts, and backend + egress networks connected BEFORE starting.
It runs only the compiled feed-observe-once.js --once entrypoint with
the signed, approved NOAA source. Docker start is executed at most once;
Docker and the worker may still fail, return zero new items or consume
the SQL poll lease. The audit container is deliberately not removed.

**Never repeat the run command** even after a failed creation, a
timed-out GET, a failed container exit or zero candidates. Reusing
another name or resetting the lease to force it is outside the grant.
Do not delete the four historic NASA canary containers, the six failed
and two completed BullMQ jobs, reset signed checkpoints or start a
producer/consumer or projector.

## After the attempt

Run only new independent read-only source/persistence witnesses:

    python3 scripts/p2_03_projection_readonly_evidence.py \
      --expected-sha REVIEWED_SHA --source-id noaa_news
    python3 scripts/p2_04_multisource_readonly_readiness.py \
      --expected-sha REVIEWED_SHA --source-ids nasa_news,noaa_news,usgs_news

The new NOAA results must be independently inspected before any new
projector authorization. A successful feed poll does NOT imply matching
NASA/NOAA events, independent publishers, current ranking rows or
permission to publish. A future publisher provenance review and an
authenticated Admin acceptance are distinct operator-controlled gates.

## Git index ownership after a root-only test

A read-only PostgreSQL witness can fail **before any SQL** with
`fatal: .git/index: index file open failed: Permission denied`.
The original privileged NOAA preflight executed `git status --porcelain`
under `umask 077`. Git is permitted to refresh/replace the index even for
`status`, potentially leaving `.git/index` owned by root with mode 0600.
The old Bash `test -z "$(git status ...)"` also accidentally treated a
failed Git command as an empty worktree. This does **not** mean the
successful NOAA GET failed, and it does **not** authorize a retry.

The updated root-only wrapper and its root Python helpers now use
`git --no-optional-locks`, explicitly require an `ap`-owned single-link
index and check Git subprocess exit codes. Root checkout inspection
must not refresh the Git index.

If the operator's read-only `stat` proves that **only** the index was
made root-owned, repair **only that existing inode**, never the whole
repository. Require current expected main SHA, no index symlink, regular
single-link file, exact observed root UID/GID and mode before changing
owner back to `ap` (UID 1000); do not alter index data or permissions.
If any predicate differs, stop and investigate. Do not run `sudo git
status` without `--no-optional-locks`. After correction, re-run the
P2-03/04 read-only witnesses; **no additional NOAA container or feed GET**.
