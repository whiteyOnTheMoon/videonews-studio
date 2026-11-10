# P2-02 – NOAA 2026-11-10 strictly one-shot metadata canary

**Status: source code + offline tests only. A merge, a green CI job, and a passing preflight DO NOT authorize a live source GET, Redis job or database writes.** The operator must independently authorize the narrow one-shot attempt and confirm fresh off-host restore and recovery evidence before using run mode.

## Warrant and evidence (2026-11-10)

Production read-only witnesses on clean main `5ab0901d40adfe31e5bb40bdcb9c01758cf22146` establish:

- DB signed sources and publisher stage / worker inbox / checkpoint / SQL source and host revision 10/10 parity: `parity_reviewable`; signed approved-host subset matches exactly; anchor digest and trust policy match. The full registry may contain extra non-granted entries, so literal full registry equality is not a required condition.
- NASA, NOAA and USGS have approved source and host grants, but no publisher provenance reviews. Existing projected articles (NASA 1, NOAA 18, USGS 0) are all older than the configured editorial age window; rankings 0. The two time-compatible pairs do NOT prove topic identity.
- Four historical feed-observer containers all exited; no active producer, consumer or feed-side published port.
- Redis ACLs for **distinct** producer and consumer identities verified; current and previous 15-minute slots absent; zero active/waiting/paused/delayed/repeat jobs; historical completed **3** and failed **6**. All six failure classes `feed_queue_execution_failed` still require operator judgment, not replay or deletion.
- Previous fixed NOAA audit container `vns-noaa-single-20261108-a5c73c9` exists in state `exited|0|0`. This is not evidence of newly available content, and its name and historical job records are reserved.

## Independent 2026-11-10 canary scope

New `scripts/p2_02_noaa_20261110_once.sh` is a minimally adapted and separately tested successor to `scripts/p2_02_noaa_one_shot_operator.sh`. It pins exactly the existing legacy worker revision and image ID, source `noaa_news` with the reviewed `https://www.noaa.gov/rss.xml` RSS metadata-only 60-minute scope and its current SQL host grant/lease, signed source revision 10/10 + public key/anchor trust, distinct PostgreSQL and Redis users, network isolation and resource limits.

- Default/read-only `--preflight` checks all prerequisites and preserves the previous audit container. It refuses if the new fixed name is already present, if the old one is not `exited|0|0`, if the historical BullMQ counts are not exactly 6 failed / 3 completed, if the current slot is occupied, if the source lease is not due, if signatures/revisions drift, or if VPS free disk falls below 9 GiB or MemAvailable below 2.5 GiB.
- `--run` is a **one-shot non-retry** operation requiring exact `--approval NOAA_20261110_SINGLE_METADATA_POLL_ONCE_NO_RETRY` and independent `VNS_P2_NOAA_20261110_RECOVERY_VERIFIED=OPERATOR_VERIFIED_OFFHOST_RESTORE_AND_SINGLE_POLL_SCOPE`, as well as every above check repeated immediately before mutation. A precise local operator acknowledgement wrapper must obtain the new explicit authorization.
- Only one new fixed-name non-restarting, non-root, read-only, portless container may be created: `vns-noaa-single-20261110-a5c73c9`. Its existing static worker code is limited to one NOAA source, one deterministic BullMQ slot (single attempt), signed HTTPS, bounded 128 KiB metadata input and up to 20 candidates, SQL lease and bounded candidate writes. It is **not** a projector, renderer, regular consumer, ranking engine or publisher.
- On any partial create/start, timeout, HTTP error, zero candidates or exit nonzero, preserve the container, queue state and source lease and **DO NOT RETRY**. Manual review is required.
- No edit/removal of old or new audit containers, queues, failed jobs, checkpoints, ACLs, Redis users, backups, registry grants or worker images. No automatic Studio refresh/status feature activation; the P4-13 seventh Compose overlay remains all false.

## Read-only VPS adoption (after reviewed PR merge)

First synchronize `ap`'s clean `main` to the exact new merge SHA. Then execute **only**:

```bash
sudo bash scripts/p2_02_noaa_20261110_once.sh \
  --preflight --expected-sha EXACT_MERGED_MAIN_SHA
```

This verifies source/SQL/Redis/queue/network/image/mount/lease but makes **no** feed GET or Docker change. If `REFUSED`, stop. The old 2026-11-08 script is historical and must **never** be used for a new live attempt.

If the new preflight passes, review current backup and isolated restore evidence, signed rights and license, capacity, scope, user-provided live permission and exact source release SHA before considering a **separate** run command. A successful canary says only that a bounded feed observation occurred, not that fresh news was stored, quality-reviewed, rendered or published. Only independent post-run read-only PostgreSQL/Redis/source/HTTP/API evidence can establish those milestones.

Tracking: Refs #489.
