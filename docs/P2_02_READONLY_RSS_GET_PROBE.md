# P2-02 – Read-only RSS GET inspection (after passing HTTPS HEAD)

This operator-only diagnostic reuses the **production** pinned HTTPS
transport and RSS decoder, but NEVER calls the scheduler, poll store,
PostgreSQL, Redis, source checkpoint, or candidate persistence.

## Preconditions and input

- Only after operator-reviewed read-only HEAD evidence of working TLS.
- Read the already signed `source-export.signed.json` from the existing
  publisher directory. Verify that the source and host approval revisions
  are those of the operator-confirmed signed checkpoint (currently 8/7).
- Pass **only** the full `registryJson` value from that file via stdin;
  never mount signing keys, DB/Redis credentials or checkpoint directories.
- `--inspect-only` is the only admitted CLI mode.
- Three `approved` RSS, `metadata_only` sources must match the fixed
  diagnostic IDs and known hosts NASA, NOAA and USGS. No fourth approved
  source, arbitrary URL or redirect is admitted.
- Run as unprivileged UID on the existing isolated
  `videonews-studio_feed_egress` network, with read-only root FS,
  all capabilities dropped, no new privileges, bounded CPU/memory/pids.
  Mount only a mode-0644 temporary copy of the probe script.
- The image must be rebuilt from the exact reviewed release SHA before use.

## Expected output

One safe JSON record per source. `metadata_accepted` with `httpStatus: 200`
means that the production transport accepted status/MIME/encoding/size,
the existing metadata decoder accepted the feed envelope and parsed
one or more articles whose links fit the approved registry URL scope.
`approvedArticleUrls` counts those **in memory only**; no data is committed.
This is not full standards-compliant XML validation, editorial verification
or proof of persisted feed ingestion.

`https_or_http_refused`, `unexpected_not_modified`, or
`metadata_refused` are intentionally fail-closed; a known fixed parser
reason may be included. No response content, raw headers, URLs, titles,
exception messages, credentials or IPs are emitted.

The HTTP 301 observed for the currently signed USGS endpoint must
remain blocked. A newly canonical endpoint, if confirmed, requires
normal Admin source/host review and a newly signed export with
checkpoint/anchor admission before any production polling.

No feed-canary, replay, checkpoint reset, lease reset, Redis queue
modification or automatic scheduler action is part of this diagnostic.

## Safe refusal classification

When GET is refused, the optional operator-only callback now reports one
closed, constant reason (e.g. `response_size_refused`,
`response_media_type_refused`, `request_timeout`, `https_unavailable`).
For `http_status_refused`, an integer HTTP status may also appear.
No upstream error messages, headers, body bytes, Location, DNS addresses
or untrusted strings reach the operator output. Normal worker execution
does not configure the callback and its public error messages stay generic.

The fixed 128 KiB response limit and every other transport admission rule
remain unchanged. Do **not** increase it or admit redirects based solely
on a failure classification; review source rights and metadata constraints
first. In particular, the NASA feed may include long article bodies, but
that is not evidence of which actual refusal occurred on the VPS.

## Narrow timeout/stream diagnosis

A complete per-request `AbortSignal.timeout(5000)` can terminate an active
RSS response stream. A stream that is closed **because this signal is already
aborted** is now classified as `request_timeout`, not as a generic
`response_stream_refused`. The actual timeout remains 5 seconds.

Fixed, non-content fields may additionally show:

- `phase: before_headers | response_body`
- `bodySizeBand: zero | under_limit | over_limit`
- `declaredLengthBand: missing | under_limit | over_limit | invalid`

The size bands are only approximations at the point of refusal; declared
Content-Length is an untrusted upstream header and need not reflect the
actual body. No raw content length, bytes, headers, URLs or upstream error
strings are emitted. These observations must not be used to circumvent
the byte/time or strict reviewed-source restrictions.

## P2-02 stream-abort event ordering

A response exceeding 128 KiB first records `response_size_refused`, **then**
destroys the stream. This prevents a synchronous `aborted` event from
mislabeling a size-based refusal as `response_stream_refused`. The
unchanged buffer limit still stops and rejects the response immediately;
it does not permit a partial feed to be decoded or persisted.
