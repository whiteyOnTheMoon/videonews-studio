# P2-02: NASA-only signed single-pass canary (code only)

**Status:** Dormant. No NASA HTTP request, VPS deployment, operator authorization, Redis/SQL write, scheduler start or publishing is included.

## Actual read-only VPS findings — 2026-11-06

Pinned VPS SHA: `b6ed820ff836fb16bc718618ef79db1c13428221`.

- NASA `nasa_news`: source approved, explicit feed URL configured, an existing poll lease present and time-eligible. Zero persisted candidates, projected articles or ranked events.
- NOAA `noaa_news`: ten persisted candidates and ten correctly mapped single-article events; no cross-source events or rankings.
- Editorial profile revision 1 requires at least **two source IDs** and articles no older than **24 hours**. NOAA currently has **zero** candidates within that age window.

A time-eligible NASA lease **does not** authorize a new GET. Even a successful NASA-only ingest would not by itself prove cross-source event matching, freshness or publisher independence.

## Explicit separate NASA gate

The signed one-shot observation path now optionally accepts:

```text
VNS_FEED_CANARY_SOURCE_ID=nasa_news
VNS_FEED_CANARY_OPERATOR_ACK=NASA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY
VNS_FEED_RUNTIME_MODE=single_pass
VNS_FEED_RUNTIME_ENABLED=true
VNS_FEED_SOURCE_BOOTSTRAP=false
```

These are **only additional software admission requirements**, not permission to set them on a VPS. All existing Ed25519 signed 10/10 source/host revision, trust-policy, SQL source/host-grant, dual Redis ACL, restricted feed writer, polling interval, one-slot BullMQ, DNS-pinned HTTPS, no-redirect, bounded size, TLS, metadata-only, and non-publication guards remain mandatory.

The selected signed entry must be `approved`, `rss`, `metadata_only`, have an explicitly configured exact `feedUrl` and both `feedUrl` and article `baseUrl` on `www.nasa.gov`. The actual paths must come from the **current independently signed export and matching SQL registry**, never from new CLI input. Do not substitute a JPL hostname or URL: `www.jpl.nasa.gov` is not `www.nasa.gov`. NOAA and USGS receive no authority query, SQL lease, DNS lookup or HTTPS request.

Missing or mismatched acknowledgement, bootstrap, changed host, revoked or missing source, missing signed feed URL, a continuous worker or producer mode are rejected. This capability makes no other-source failover attempt.

## Before any separate live approval

1. Read-only review the **exact current signed NASA feed and article scopes**, license/rights and independent host approval, existing anchored 10/10 checkpoint, trust policy and actual feed transport identity.
2. Read-only inspect the NASA SQL poll lease and historical BullMQ jobs. Never delete, rerun or reset prior jobs, leases or checkpoints.
3. Obtain fresh and exact operator authorization for **one NASA-only metadata persistence canary**; past USGS GET permissions are consumed and do not apply.
4. Only then review a fresh pinned-release VPS command. After any single run, separately verify persisted metadata, event projection, deduplication, current-profile ranking and the authenticated Admin UI.
5. Do not lower the profile's two-source threshold or extend article age simply to create a ranking.

This PR changes no source rights, migrations, signed export, runtime secrets, publisher key, production data or VPS processes. P2-02 and P2-03 remain open.

## 2026-11-06: 128-KiB live response refusal and dormant bounded review path

The operator's **single explicitly approved** NASA-only canary was run once
on `72f0605a5163325d0b2c979bdef0f61d9abc8131`. The exact signed
endpoint was `https://www.nasa.gov/news-release/feed/`. HTTPS returned
an over-limit response body with no declared Content-Length; the 128-KiB
stream guard refused it before parsing or persisting metadata. BullMQ
failed jobs increased from three to four, and the failed observer
container was retained. The SQL poll lease was consumed. **That canary
approval is spent.** See #448.

An initial post-canary signed SQL witness falsely blocked because it
called a staging CLI that rejects retained, exited feed-observer
containers. Read-only witness fix #449 was merged as
`7333ff6aea8dd73a6073e6653c89fd521aedf79a`; VPS rerun returned
`parity_reviewable` with signed stage/inbox/checkpoint, SQL source/
host revision 10/10, matching anchor digest and preapproved trust policy.
No remediation or checkpoint reset was necessary.

### Code-only option for future separately authorized review

By default, the HTTPS **and** XML-decoder response limits both remain
131072 bytes for **every** source, including NASA. Raising the HTTPS
limit alone would just move the refusal to `decodeApprovedFeed()`.

A separately locked path allows **at most 524288 uncompressed response
bytes** _only_ when all of the existing signed-source, same-VPS anchor,
rights, selected-NASA-only, restricted SQL/Redis and one-shot gates
pass, **and** the following two extra environment variables are
provided:

```text
VNS_FEED_NASA_512K_ENABLED=true
VNS_FEED_NASA_512K_OPERATOR_ACK=NASA_EXACT_SIGNED_NEWS_RELEASE_512K_ONLY
```

The signed source must still have the exact URL
`https://www.nasa.gov/news-release/feed/`, source ID `nasa_news`,
`approved` status, `rss` access and `metadata_only` usage.
The gate is rejected in continuous, persistent, producer, NOAA, USGS,
unsigned/different URL, bootstrap, missing/mismatched acknowledgment and
unselected runtime modes. Even with this gate, the response is still
fully bounded, validated for redirects, compressed content, HTTP status,
TLS/DNS pin, media type, UTF-8 and whole-document XML safety.
**Neither truncation nor compression fallback is introduced.**
The existing maximum of 20 decoded metadata items and canonical
article URL SQL guards are unchanged.

This is an _option for offline review_, **not** approval to set the new
flags or repeat the live feed request. The previous one-shot image
and retained container must stay untouched. Before any subsequent
attempt, independently confirm the current NASA terms/exact feed URL,
review the bounded memory/timeout impact and latest source output
behavior, issue **fresh explicit operator authorization**, validate a
new pinned image and runtime environment, use a fresh eligible SQL
lease and BullMQ slot and preserve prior failures. A 512-KiB refusal
is still possible if NASA sends more bytes; do not automatically raise
the bound or retry. No permanent scheduler or publication is permitted.
