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
