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

## Actual operator evidence — 2026-11-06

On release `ee9648e44a75823bc2adf3a487b5c99f2ac16e43`, a **separately approved single USGS GET** reached the parser and returned:

```json
{
  "scope": "usgs_single_readonly_get",
  "sourceId": "usgs_news",
  "stage": "metadata_refused",
  "reason": "no_approved_metadata"
}
```

This confirms that the approved URL returned a 200 response that passed the existing TLS/DNS, size, MIME, encoding and framing checks. At least one RSS item was recognized; none survived all link, headline, date and deduplication rules. The actual rejection category was **not captured** in that run. A transient earlier `https_transport` failure is not proven fixed by one subsequent successful HTTPS response.

No USGS candidates were persisted. The `metadata_commit` stage was not reached. The authorization for this GET is consumed: do **not** rerun it to determine the reason.

## Additional count-only diagnostic for a separately authorized future GET

If, and only if, a future operator approves another USGS-only GET, the diagnostic can report an extra `rejectionCounts` object on `no_approved_metadata`. The report uses the same production RSS parser and admission predicates as before. Categories are mutually exclusive in rejection order:

- `scanned`: 1–20 supported RSS entries inspected in memory
- `outsideApprovedPrefix`: article link does not begin with the signed `https://www.usgs.gov/news/` prefix
- `invalidOrBlockedLink`: the link lies under the prefix but fails canonical URL/blocked-subscope admission, or has no usable value
- `invalidHeadline`: canonical admitted link but invalid title
- `invalidPublishedAt`: admitted link and title but invalid nonempty publication date
- `duplicate`: an already accepted URL within the same response

The report contains only small integer counts; it never logs actual URLs, titles, timestamps, article bodies, parsed XML or specific bad values. The existing `decodeApprovedFeed` behavior and production worker are unchanged. No extra network call is made to calculate counters; only the already received in-memory response is inspected a second time. A diagnostic failure never changes the refusal.

This enhancement does not authorize a new GET and cannot retroactively identify why the last test returned `no_approved_metadata`. Do not relax source URL scope, title rules, date checks or publishers' rights to force ingestion.

## Second operator result — 2026-11-06

On `cd5e1cc5813a920714a9667105091601eb5aeda3`, one explicitly approved, read-only USGS GET returned `metadata_refused / no_approved_metadata`. Exactly the first 20 RSS entries were scanned:

```json
{
  "scanned": 20,
  "outsideApprovedPrefix": 0,
  "invalidOrBlockedLink": 20,
  "invalidHeadline": 0,
  "invalidPublishedAt": 0,
  "duplicate": 0
}
```

Every inspected entry failed the existing URL validation or lacked an extractable link. Since link checks short-circuit title and date checks, their zero counters are **not evidence** those fields would have been valid. No HTTP retry, DB write, Redis write, checkpoint advance, projection or publishing occurred. The GET permission is consumed.

For a separately authorized **future** diagnostic only, `rejectionCounts.linkFailureReasons` now divides the existing `invalidOrBlockedLink` aggregate into these mutually exclusive count-only codes:

- `missingOrUnreadable`: the RSS extractor yielded no usable link text
- `queryString`: a query is present, which is not permitted for persisted candidate URLs
- `fragment`: a URL fragment is present
- `percentEncoded`: percent encoding is present
- `dotSegments`: a raw `/./` or `/../` segment appears
- `invalidPublicUrl`: the value fails the existing public-HTTPS lexical gate
- `nonCanonical`: parsing normalizes the URL to a different spelling
- `blockedOrUnapprovedScope`: a canonical link is not approved for that source
- `other`: a rejected link did not match a narrower safe classification

All counters are small integers, sum to `invalidOrBlockedLink`, and never expose URL values, headlines, dates, raw RSS, remote headers or secret material. The existing production `canonicalArticle` and `decodeApprovedFeed` checks are **unchanged**. Do not attempt a new GET under either previously consumed permission, do not broaden USGS host or article-scope approvals, and do not delete historical queue or lease evidence.

## Third authorized USGS GET — 2026-11-06

On production-pinned release `ed42b922d49816df74459eacd0088f986dbdeb2a`, the separately approved, isolated **single** GET returned the following **observed** classification, without SQL, Redis, queue, lease or checkpoint changes:

```json
{
  "scope": "usgs_single_readonly_get",
  "sourceId": "usgs_news",
  "stage": "metadata_refused",
  "reason": "no_approved_metadata",
  "rejectionCounts": {
    "scanned": 20,
    "outsideApprovedPrefix": 0,
    "invalidOrBlockedLink": 20,
    "linkFailureReasons": {
      "missingOrUnreadable": 0,
      "queryString": 20,
      "fragment": 0,
      "percentEncoded": 0,
      "dotSegments": 0,
      "invalidPublicUrl": 0,
      "nonCanonical": 0,
      "blockedOrUnapprovedScope": 0,
      "other": 0
    },
    "invalidHeadline": 0,
    "invalidPublishedAt": 0,
    "duplicate": 0
  }
}
```

The **precise existing rejection cause is a query string on all 20 USGS links**. Their titles and published dates were not validated because link admission rejects them first. The current PostgreSQL `vns.commit_feed_poll_authorized` also rejects any `?` in a candidate URL, so simply deleting the TypeScript guard would be incorrect and may cause a rejected batch. That operator authorization has been consumed; **do not repeat the GET**.

### Dormant, count-only tracking-key review and dry-run

For a **separately approved future** USGS-only diagnostic, and only when an actual downloaded response was rejected by the existing parser, the read-only probe also reports `rejectionCounts.trackingQueryPreview`, containing:

- `inspectedQueryLinks`: bounded count of items with query strings (up to 20)
- `recognizedKeyCounts`: *only* fixed well-known analytic query key names and the number of items bearing each. Known names: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `utm_id`, `gclid`, `fbclid`, `mc_cid`, `mc_eid`
- `trackingKeysOnly`: number of links where every query parameter uses one of these keys, with no repeated key and nonempty bounded values
- `unknownOrMixedKeys`: count with an unrecognized, duplicate, empty or otherwise disallowed parameter
- `malformedOrUnusableQuery`: count rejected by the HTTPS lexical/URL parsing preflight
- `wouldPassExistingUrlAndMetadataGuards`: number of distinct article paths which would pass the *current* signed source-scope, title and date guards in an **in-memory simulation** if these recognized analytics-only fields were removed
- `canonicalCollisions`: number of otherwise valid distinct feed entries whose hypothetical canonical path would duplicate another

This is **only a hypothetical calculation**: no actual production URL is rewritten, persisted, fetched again, dereferenced or published, and no source grant is expanded. No raw URL, parameter **value**, headline, publication time, article body, unknown parameter **name**, or response body is output. Even if all 20 entries have familiar tracking key names, that does **not** by itself prove those parameters are non-semantic or authorize removal. A separate publisher/source semantics review, canonicalization policy and explicit operator authorization remain necessary before changing production ingestion.

Do not substitute the separately indexed `/news/all/feed` endpoint: the signed 10/10 source export authorizes **only** `/news/149248/feed`. No migration or live service start is part of this change. Historical failed jobs, leases and publisher rights must remain unchanged.
