# P2-02: NASA RSS decode refusal after a bounded, single-source canary

## Observed production evidence

The operator independently authorized a **second** NASA-only metadata canary
using the SHA-pinned release
`0dc1fa0479e43b9093c483eebc38a442ff26bce1`, worker image
`sha256:2dc8c076c908cb7fe2ee675f9ef1d5fc86c16e3301188df07e10fe8d5afcf01b`,
and the newly bounded 512-KiB transport gate. The preflight attested the signed
source, SQL anchor, lease and empty queue slot. The freshly created observer
`vns-nasa-canary-0dc1fa0479e4` passed container admission and ran **once**.

The sole emitted poll stage was:

```json
{ "event": "feed_poll_failure_stage", "sourceId": "nasa_news", "stage": "feed_decode" }
```

The observer exited 1. The read-only P2-03 evidence found zero NASA feed
candidates, projections and rankings, while the isolated Redis queue contained
five failed historical jobs, one completed job and a present current-slot job.
The existing and new exited containers and all BullMQ records remain preserved.

The transport did **not** report a 512-KiB-size refusal this time. The failure
occurred in downstream RSS response validation, XML parsing or the final
source-authorized metadata filter. The specific cause **cannot be reconstructed**
from prior output: the one-shot worker never persists raw XML or error details.
Do not infer a particular feed format, URL parameter or publication date.

## Opt-in future fixed-label diagnostics only

The new diagnostic is **off by default**, even when the ordinary failure-stage
reporter is on. It is eligible only when all of the following are true:

- The existing, exact NASA-only, `single_pass` source selection and rights
  admission remain valid.
- The previously reviewed 512-KiB bounded response gate is enabled with its
  independent exact acknowledgment.
- `VNS_FEED_POLL_STAGE_DIAGNOSTICS=true` and
  `VNS_FEED_NASA_DECODE_DIAGNOSTICS=true`.

On a future independently approved **new** single-pass NASA canary, a decoder
refusal may emit exactly one event containing the literal source ID and one
allowlisted reason: `response_invalid`, `media_type_refused`, `xml_unsafe`,
`xml_envelope_invalid`, `no_supported_items`, `no_approved_metadata`,
`official_json_invalid`, `official_shape_invalid`, or `other`. Raw XML,
URLs, headline text, publisher headers, credentials, exceptions and arbitrary
error messages are **never** included. A malformed or forged diagnostic is
ignored. A callback error cannot change the failed status or write metadata.

These labels do **not** bypass the XML envelope, DTD/entity, source URL,
metadata validation, 512-KiB limit, source signature, host grants, SQL lease,
BullMQ one-slot gate or non-publication rules.

**The previous authorization is consumed.** This code change is not approval to
start, retry, remove any container, clear jobs or reset leases. Without a fresh,
explicit operator authorization, future work is limited to offline tests,
read-only evidence and documented review. P2-02/P2-03 remain open.

## Third canary: `no_approved_metadata` and dormant count-only review

The **third** separately authorized NASA-only single-pass observer was executed
on the VPS with pinned release `9184e896eca9f8517934ecaa1b59cd7307564c09`
and the 512-KiB-bound image
`sha256:b1422ee57ae49635f648d8ef27e5163dfa1bbaa86d1517feecbe10628a948f6d`.
All 32 offline tests, signature/SQL-source parity, lease/slot and container
checks passed. The observer emitted **`feed_decode_refusal` with
`kind=no_approved_metadata`** and exited 1. PostgreSQL has no NASA candidates;
the BullMQ queue contains six preserved failed jobs, one completed job and an
occupied latest slot. No publication occurred. The third one-shot approval
is **consumed** and none of the three historical observer containers or queue
records may be cleared or restarted.

The fixed refusal label proves that the response got through the HTTPS and
RSS envelope/item parsers but no item met all metadata gates. It does **not**
prove that a particular NASA URL contains tracking parameters or uses a
different approved path. No raw feed was retained; the original item-level
rejection classes cannot be reconstructed from those logs.

The new opt-in, **default-off** diagnostic uses the already buffered,
already rejected NASA response **without additional DNS, HTTPS or SQL**:

```text
VNS_FEED_NASA_REJECTION_COUNTS=true
```

It requires the pre-existing separately acknowledged NASA 512-KiB single-pass
scope, `VNS_FEED_POLL_STAGE_DIAGNOSTICS=true` and
`VNS_FEED_NASA_DECODE_DIAGNOSTICS=true`. It activates only when the existing
decoder throws the fixed `no_approved_metadata` refusal. It then calls the
existing `summarizeFeedMetadataRejections` helper on the same in-memory
response. The emitted object contains fixed numeric counters, at most 20 items:
`scanned`, `outsideApprovedPrefix`, `invalidOrBlockedLink` with exclusive
reasons (`missingOrUnreadable`, `queryString`, `fragment`,
`percentEncoded`, `dotSegments`, `invalidPublicUrl`, `nonCanonical`,
`blockedOrUnapprovedScope`, `other`), `invalidHeadline`,
`invalidPublishedAt`, `duplicate`, and `accepted=0`. Counts must be
internally consistent; other values are discarded.

No raw URL, query key/value, RSS payload, headline, publication time, error
string or credential is emitted. The source approval, strict canonical URL,
title/date checks and the actual no-commit result are not changed. A failure
in classification or emission is ignored and cannot turn a refusal into
success. This diagnostic is **only a code capability**, not authorization for
another live NASA request. A new single-pass operator approval and complete
preflight would be required before using it on the VPS. P2-02/P2-03 remain open.

## Additional closed-count tracking-vs-unknown query preview (offline first)

A second independent opt-in, `VNS_FEED_NASA_QUERY_PREVIEW_COUNTS=true`,
requires `VNS_FEED_NASA_REJECTION_COUNTS=true` and all prior NASA-only
512-KiB, `single_pass`, signature and failure-stage diagnostic gates.
The flag defaults to **false** and does not enable any source or authorize
another GET.

Only after the unchanged feed decoder reports `no_approved_metadata`, the
existing `previewRejectedFeedTrackingQueries` inspects the **same**
bounded response in memory. The emitter validates an allowlisted,
internally consistent object before logging counts:

- `inspectedQueryLinks`: total RSS item links with `?`;
- `trackingKeysOnly`: links containing exclusively the ten fixed
  recognized tracking key **names** (no values);
- `unknownOrMixedKeys`: links containing functional-looking, unknown or
  mixed names; the names themselves are never logged;
- `malformedOrUnusableQuery`: links excluded by preview validation;
- `wouldPassExistingUrlAndMetadataGuards` and
  `canonicalCollisions`: **simulation only**, not a policy grant;
- `recognizedKeyCounts`: counts under the same ten fixed code-owned names.

No individual query string, URL, title, article ID, parameter value, XML,
secret or exception can escape. Every count is bounded by the 20-item
decoder cap. The simulation may detect a possible collision and must never
be interpreted as permission to strip a real-world query parameter.
A reporter exception cannot affect the original failed poll or its
SQL no-commit state.

This allows a **future** separately authorized one-shot observation to
return metadata refusal categories and tracking-vs-unknown query counts
with one bounded HTTPS request, rather than spending another fetch to
classify a suspected query rejection. It does not determine the cause of
the three previously consumed NASA canaries.
