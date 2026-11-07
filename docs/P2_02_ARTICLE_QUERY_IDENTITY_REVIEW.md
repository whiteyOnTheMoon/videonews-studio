# P2-02: Article query parameters are identity-sensitive (design-only review)

**State:** Proposal and offline regression evidence only. No production parser,
SQL schema, signed source registry, source grants, feed URL, publication policy,
or runtime default is changed. No additional NASA GET is authorized.

## Triggering production evidence

The third expressly authorized, one-shot NASA canary on
`9184e896eca9f8517934ecaa1b59cd7307564c09` emitted
`feed_decode_refusal: no_approved_metadata`. NASA has zero persisted feed
candidates; there are six preserved failed BullMQ jobs, one completed job, and
three exited canary containers. No original RSS XML was retained. **We have not
proved that a query string caused the refusal.** The new default-off numeric
diagnostic in `e22d04f130e01d80d20221a7754235ee35ee1bbb` can, if another
one-shot GET is independently approved, report query-related rejection counts
without logging URLs. Until then, do not assume NASA uses any specific
parameter names or change its review grants.

## Verified current constraints

- `feed-poller.ts` uses `canonicalArticle()`; it refuses any `?`, `#`,
  `%`, dot-segment or differently owned URL. It does not strip tracking keys.
- SQL `vns.commit_feed_poll_authorized` from migration 0033 independently
  rejects `?`, `#`, `%` and dot segments before insertion; changing only
  TypeScript would still fail the entire guarded SQL batch.
- `vns.feed_poll_candidates` from migration 0019 has primary key
  `(source_id, article_url)`. The projector from migration 0028 additionally
  requires `article_url ~ '^https://[^[:space:]?#]+$'` and copies that value
  to `research_articles.canonical_url`. Query-aware support therefore requires
  reviewed **ingest, SQL, projection and identity** changes, not a decoder-only
  patch.
- Signed source records from migration 0050 have exactly nine or ten approved
  fields (including optional exact `feedUrl`) and explicitly exclude
  query-bearing `baseUrl` and `feedUrl`. A future article-query exception
  must not be smuggled into these fields or supplied by an environment flag.
- The existing `previewRejectedFeedTrackingQueries()` is an **in-memory
  diagnostic simulation**, not an approved canonicalization function. It
  counts tracking-key-only links and potential collisions, without permitting
  storage of those links or logging parameter values.

## Identity counterexample (synthetic, not a NASA claim)

These two links can designate **different articles**:

```text
https://www.example.org/news/item?article_id=101
https://www.example.org/news/item?article_id=102
```

Erasing the query collapses both to the same path. Conversely,
`?utm_source=rss` often represents campaign attribution rather than identity,
but neither that label nor a familiar key name independently proves a parameter
is removable for a particular publisher. Preserve complete original links
until source-specific evidence proves otherwise.

## Proposed staged architecture — not yet implemented

1. **Evidence gate.** Obtain count-only refusal reasons for the signed NASA
   source only during a separately authorized one-shot observation, or use
   owner-provided, license-reviewed sample RSS offline. Keep payloads out of
   logs and application persistence. No hidden network probe.
2. **Independent source review.** For each article URL pattern, confirm exact
   publisher host, path scope, ownership, meaning of allowed query keys, limits
   and any justified tracking removal. An unknown, empty, repeated, encoded,
   nested-URL, fragment, or mixed parameter must fail closed until explicitly
   reviewed. A queryless legacy source remains unchanged.
3. **Separate exact navigation and identity.** Preserve the verbatim,
   independently validated original URL for editorial navigation. Compute a
   separate *identity* only under the signed, revision-anchored source policy.
   Functional parameters (such as a verified article ID) belong in the
   identity. Do not equate distinct articles merely because their paths match.
   Never follow a parameter as a redirect or turn it into a new feed endpoint.
4. **Bounded canonicalization.** Require HTTPS, exact host/path grants, no
   credentials, userinfo, fragments, dangerous encodings, network-target
   parameters or unsupported normalization. Reject duplicate keys and
   ambiguous decoding. Any removal of confirmed tracking keys must have
   publisher-specific tests proving nonidentity, and must not combine distinct
   articles. Repeated or unknown parameters cannot be discarded or reordered
   by default.
5. **Atomic SQL parity.** Add a separate reviewed migration for source-key
   permissions, original URL and canonical identity, SQL-side guarded
   validation and revisions. Keep the current `SECURITY DEFINER` role
   restrictions and source/host row locks. The same signed approval must be
   checked at claim and final commit. Version existing projection logic and
   uniqueness constraints together. Preserve all existing candidate and
   article identities, including dedupe, restart, idempotence and historical
   rows; do not mass-rewrite prior URLs.
6. **Offline acceptance gate.** Synthetic cases must cover distinct functional
   IDs on the same path, tracking-only variants, mixed keys, duplicate keys,
   empty values, encoded separators, case changes, query ordering, unapproved
   child scopes, hostile URL-like values, >512-character URLs, and two sources
   with overlapping hosts. TypeScript and PostgreSQL must agree, and
   projection must not silently filter accepted query-bearing candidates.
   Test an old default-off source still rejects every query-bearing article.
7. **Release gate.** Ship the code dormant, require a new signed source-policy
   revision and independent operator rights/host approval before any opt-in;
   read-only production witnesses first, then a separately authorized,
   individually bounded live canary. No scheduler, retry or publication is
   bundled with this design.

**Decision:** Do **not** drop `?` or globally permit query parameters now.
Wait for validated, source-specific evidence and then implement a reviewed,
collision-safe TS/SQL/projection change as one separately tested package.
