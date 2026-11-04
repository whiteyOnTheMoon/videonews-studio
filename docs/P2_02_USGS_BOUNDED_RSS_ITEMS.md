# P2-02 – Bounded RSS processing for official feeds listing more than 20 items

## Live evidence (operator, 2026-11-04)

- `usgs_news` original approved endpoint `https://www.usgs.gov/news/national-news-release/feed`: HTTPS HEAD returned HTTP 301.
- The **not-followed**, same-host HTTPS redirect target was `https://www.usgs.gov/news/149248/feed`.
- A direct, DNS-pinned read-only GET to that target returned HTTP 200, RSS media type, **27,935 bytes** (below 128 KiB).
- The existing `decodeApprovedFeed` rejected the diagnostic body with `Feed item limit exceeded` before checking usable article metadata.
- The approved source registry and signed-source checkpoint still point to the original operator-approved endpoint. This diagnostic target is **not** automatically approved for production.

## Change

- For an RSS or Atom response, inspect **only the first 20 entries in document order** instead of rejecting the entire bounded response when it contains an additional entry.
- Apply the existing full-body forbidden-XML check and the strict RSS/Atom envelope check before item selection.
- Preserve the HTTPS limit of **131,072 bytes**, the allowed MIME types, DNS pinning, TLS validation, no redirects/compression, per-entry headline checks, canonical article scope, editorial review state and deduplication.
- No paging or subsequent article fetches. Feed XML, titles and full URLs are not logged.
- When a feed is not ordered newest-first, this policy does **not** guarantee that the newest 20 items were selected; do not present partial ingestion as exhaustive or guaranteed current coverage.

## Approval and deployment gates

This code change changes **parser behavior only**. It does not approve new source endpoints, source-host permissions, rights grants, registry revisions, signed exports or publisher provenance.

Before production polling the USGS target, require independent operator review of its exact URL and article scopes, a signed revised source export and checkpoint/anchor handoff, then a bounded one-shot canary and independently verified database projections. Preserve historical failed jobs, existing poll leases and source revisions; never reset them to make the canary succeed.

If a subsequent read-only parser diagnostic still returns `Feed has no approved metadata`, examine safe aggregate metadata classification and article-scope compatibility; do not broaden article scopes automatically.

NASA still has an independently observed response over 128 KiB and is not fixed by this change.
