# P2-02 — Controlled USGS-only read-only HTTPS diagnosis

**Status: dormant until separate operator approval.** Code does not run on merge.

## Problem addressed

The operator-approved USGS canary on release `82fecc9ad4dc` stopped at `https_transport`, before any USGS candidate persisted. The new one-shot observer diagnostics in `ff9c8f54b381` cannot retrospectively reconstruct a network error. Do not replay the failed BullMQ job or reset its PostgreSQL lease.

This tool performs **at most one unconditional, DNS-pinned HTTPS GET** for the signed, approved `https://www.usgs.gov/news/149248/feed` endpoint without touching Redis, PostgreSQL, leases, jobs, checkpoint writes, publishing or AI. It is **not** a feed canary and does not prove metadata persistence.

## Admission

The worker entrypoint is `node apps/worker/dist/feed-usgs-readonly-https-probe.js --inspect-usgs-only`. It requires:

- `VNS_P2_USGS_GET_DIAGNOSTIC_ENABLED=true` and the **separate** literal `VNS_P2_USGS_GET_DIAGNOSTIC_ACK=ONE_READ_ONLY_USGS_HTTPS_GET_DIAGNOSTIC_ONLY`.
- `VNS_SOURCE_FETCH_ENABLED=true`, and exactly `VNS_ALLOWED_SOURCE_HOSTS=www.nasa.gov,www.noaa.gov,www.usgs.gov`. These other hosts are verified in the signed registry, **never contacted**.
- An existing Ed25519-signed publisher export, already imported into the UID10002-only inbox, with source/host revision exactly 10/10.
- An existing UID10002-only worker checkpoint with the **same signed-envelope digest**, also 10/10.
- A separately pinned Ed25519 **public** key mounted read-only, root-owned mode 0440, worker group 10002.
- Exactly the already approved three RSS metadata-only entries. USGS base/article scope and feed URL must match the reviewed literal. No source selection through untrusted CLI input.
- A separate operator-reviewed and still-current source/host rights audit and SQL anchor coherence check **outside** this tool; no database connection is permitted within it.

The diagnostic has no secret password, signer private key, backend network, PostgreSQL or Redis mounts. Run only with a dedicated `docker run --rm --network videonews-studio_feed_egress --user 10002:10002 --read-only --cap-drop ALL --security-opt no-new-privileges`, pinned release image and readonly bind mounts for the **two private source directories and one pinned public-key file**. Do not reuse the old `feed-observer` Compose profile: that service contains database and queue credentials and may enqueue a job.

The tool checks no global timer or interval; a human operator must review the intended single GET's acceptable time, rate and rights before authorizing it. It uses only the existing 5-second DNS/TLS request deadline, 128-KiB response limit, exact TLS hostname validation, DNS public-IP pinning, no redirects, strict media type and UTF-8. No feed article content is retrieved.

## Safe output

A single bounded JSON record, such as:

```json
{
  "scope": "usgs_single_readonly_get",
  "sourceId": "usgs_news",
  "stage": "https_or_http_refused",
  "refusal": "request_timeout",
  "phase": "before_headers"
}
```

The example does **not** establish the actual failure cause. Other outcomes include `metadata_accepted` with an in-memory approved-URL count (max 20), or `metadata_refused` with a fixed reason. No URLs, IPs, raw headers, response bodies, titles, exception details, or private credentials are logged.

If `metadata_accepted` succeeds, it establishes transport and decoder acceptance for that single test, **not** that the earlier live HTTPS failure was fixed, nor that the database commit would work. Stop after any result; do not automatically repeat.

## Required next action

Obtain **new explicit approval** for one USGS-only HTTPS GET after the software preflight and VPS state review. The previous single-pass feed canary approval is consumed. Retain the previously failed Redis jobs and lease. No new source rights, no permission relaxation, and no automated retry.
