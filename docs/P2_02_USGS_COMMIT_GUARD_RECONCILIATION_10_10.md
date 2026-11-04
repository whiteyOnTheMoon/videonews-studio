# P2-02 – USGS metadata commit rejection at signed revision 10/10

**Status: bounded code compatibility fix; neither an independently established root cause nor permission to restart a feed.**

## Operator evidence, 2026-11-05

A manually authorized `usgs_news`-only `single_pass` observation against the exact approved URL `https://www.usgs.gov/news/149248/feed` reached the fixed failure stage `metadata_commit` and returned a failed BullMQ job. The separately performed read-only inventory found:

- PostgreSQL source and host approvals: **10/10**.
- Private worker checkpoint and SQL high-water anchor: **10/10**, matching envelope digests.
- Trust-policy high-water: **revision 1**.
- USGS poll next eligible: **2026-11-05 00:50:01 UTC** at inventory time; the lease was **not** eligible.
- USGS stored candidate count: **0**; existing candidates across sources: **10**.
- Isolated queue: **2 failed** jobs, **1 completed**, **0 waiting/active/delayed**.

The signed handoff succeeded before the failed poll. No checkpoint reset, anchor rollback, SQL lease adjustment, failed-job removal or rerun is appropriate. The same-VPS anchor still shares the VPS/PostgreSQL restore domain.

## Verified contract mismatch

The RSS decoder's `canonicalArticle` previously checked the approved article scope and percent-encoded *pathname* but admitted an otherwise in-scope, canonical URL containing a query such as `?utm_source=official`. The currently deployed guarded SQL function `vns.commit_feed_poll_authorized` deliberately rejects any article URL containing `?`, `#`, `%`, `/./` or `/../`, and it aborts the entire batch if **one** item fails.

This is a concrete, locally demonstrated decoder/SQL mismatch. **No article URLs or database error details from the failed USGS batch were recorded**, so it remains unproven that this mismatch caused that specific live failure. SQL role, source/host guards, timestamp/validator or metadata-shape failures are still possible.

## Narrow fix

The metadata-only decoder now excludes URLs that the existing SQL URL guard would reject, without altering any URL, silently stripping query parameters, following redirects, loosening database constraints or authorizing extra sources. A regression test mixes query-bearing, encoded, fragment-bearing and dot-segment links with a valid article URL, and asserts the resulting bounded feed pass sends only the valid one for persistence. A query-only feed still fails closed rather than claiming successful ingestion.

**Unchanged:** the three-source signed registry prerequisite; USGS one-shot selector/ack; 20-item/128-KiB limits; DNS-pinned HTTPS; per-source leases; PostgreSQL guarded claim/commit; immutable job history; publication disabled.

## Production follow-up – not automatic

1. Confirm GitHub PR checks before merging. The operator alone builds and pins a new worker image on the VPS; this change does **not** deploy.
2. Before any new external request, read-only reconcile the source/host registry, anchored 10/10 envelope, trust-policy, Redis queue, exact source rights, and current USGS lease.
3. Inspect failures and diagnostics without copying raw SQL exceptions, article URLs, RSS XML, credentials or full job payloads into chats/logs.
4. A new single-pass USGS canary, **if separately authorized**, must use a fresh 15-minute queue slot and the lease's normal eligibility; never reprocess or delete the failed job to make the test pass.
5. Verify persisted USGS candidates, guarded projection, ranking, authenticated Admin GET and failure recovery independently. A parser/CI pass does not prove production persistence or close P2.

If the next authorized observation still reports `metadata_commit`, stop: diagnose the remaining SQL guard and format mismatches using bounded aggregate evidence, rather than relaxing commit guards or repeating jobs.
