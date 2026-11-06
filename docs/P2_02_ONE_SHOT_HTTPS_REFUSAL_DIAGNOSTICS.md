# P2-02: One-shot USGS HTTPS transport refusal diagnosis

**Scope: code and synthetic CI only.** This change does not authorize a new external request, claim a PostgreSQL lease, enqueue a BullMQ job, project an event, clear a failure, or modify the source rights.

## Evidence and reason for the change

The operator's single explicitly approved USGS observation of the signed, reviewed revision **10/10** with release `82fecc9ad4dc91fd86c01d7d03d44381794ac82a` entered the production poller and reported:

```text
{"event":"feed_poll_failure_stage","sourceId":"usgs_news","stage":"https_transport"}
observer_exit_code=1
```

The read-only P2-03 witness still found zero persisted USGS candidates. This does **not** establish that the previous `metadata_commit` issue was resolved: the new run stopped earlier. The associated historical BullMQ job and SQL poll lease must remain unchanged. No retry is permitted under the consumed authorization.

The pinned HTTPS transport already classifies a fixed set of refusals, covering DNS, TLS, timeout, response code, size, stream framing, compression, headers, MIME, UTF-8 and unexpected 304 bodies. Previously the _live one-shot observer_ failed to connect this existing narrow diagnostic callback, leaving only the broad `https_transport` stage.

## Narrow operator-only visibility

`feed-observe-once.ts` now attaches a classified refusal callback only when **all** of these conditions hold:

- `VNS_FEED_POLL_STAGE_DIAGNOSTICS=true`
- `VNS_FEED_RUNTIME_ENABLED=true`
- `VNS_FEED_RUNTIME_MODE=single_pass`
- `VNS_FEED_SOURCE_BOOTSTRAP=false`
- One exactly selected NOAA or USGS source with its matching distinct `VNS_FEED_CANARY_OPERATOR_ACK` token

The reporter emits an additional line of form:

```json
{
  "event": "feed_https_refusal",
  "sourceId": "usgs_news",
  "kind": "request_timeout",
  "phase": "before_headers"
}
```

This is **an example, not the determined cause** of the recent failure. The actual classification must be observed on a separately authorized future run. The `kind`, source ID and optional phase/size bands are strictly allowlisted; an HTTP status is an integer 100–599 and appears only for `http_status_refused`. No URLs, IPs, DNS values, headers, content, exception strings, credentials or response bodies are logged. The callback cannot weaken an existing refusal, make a second HTTP request, or turn a failed job into success. Normal persistent producer/consumer and any unselected feed observation remain silent.

The transport's existing **5-second timeout, 128 KiB size limit, DNS pinning, TLS verification, exact approved host, no-redirect rule and strict MIME/encoding constraints are unchanged**.

## Operator next steps — no automatic canary

1. Read-only inventory the recorded failed job (currently expected 3 failed / 1 completed), its 15-minute slot and the updated USGS lease; preserve all evidence.
2. Inspect the actual Compose feed egress network and container configuration without exposing secret mounts or values; no host firewall or DNS relaxations based on an unclassified failure.
3. Optionally propose a **separately approved** single-source, no-DB/Redis GET diagnostic using the same pinned HTTPS transport, bounded to the exact approved USGS endpoint. Do **not** use the existing all-three-sources probe without separate source-specific permission.
4. Only after new explicit operator authorization and a pinned new release/image should another one-shot source observation be considered; its additional `feed_https_refusal` label can then distinguish the exact refusal.
5. A successful transport alone does not close P2-02/P2-03. Check immutable PostgreSQL candidate persistence, independently approved one-shot projection, actual source provenance, private Admin GET, ranking and publication-disabled status.

CI covers opt-in and wrong-ACK refusal, source scoping, every conditional metadata field class, forged/untrusted reason rejection, swallowed logger failures, and the existing real transport test suite. No live VPS or external feed is contacted by this patch.
