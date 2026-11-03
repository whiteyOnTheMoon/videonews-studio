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
