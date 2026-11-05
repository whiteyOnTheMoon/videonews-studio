# P2-03 conservative offline event candidates

The `groupConservativeEventCandidates` worker utility groups only tightly overlapping metadata headlines from a bounded batch. Before grouping, it independently recomputes each article's canonical URL/source identity and normalized headline fingerprint; malformed timestamps, forged IDs, copied headline hashes and duplicate canonical URLs are rejected. This is an integrity check of **metadata**, not an independent publisher authenticity or fact-verification check. It is explicitly candidate-only, deterministic across input ordering and checks every pair in a proposed group. Exact fingerprint duplicates are grouped; otherwise at least six shared normalized tokens, Jaccard overlap >= 0.8, and a <=48-hour time separation are required. Ambiguous matches are not combined. No semantic, cross-language or true syndication detection is claimed. Group IDs depend on current member IDs and must not be used as stable persisted event identities.

Independent source IDs do **not** establish true independent verification: syndication and provenance remain unverified. Every group retains `independent_verification_required` and is never approved for publication. The existing exact-heading function remains unchanged. This utility is not wired into a production worker or persistent PostgreSQL event reconciler, and there are no real sources, costs or VPS changes. The outstanding acceptance criterion in #18 remains open pending durable event identities, reviewed publisher provenance and end-to-end worker/database tests.

## Exact-title recurrence protection (offline P2-03)

The older `groupExactHeadlineEvents` path used a single normalized-title hash for all time periods. Identical agency bulletin titles from a past news cycle could therefore be grouped with new articles, making the combined event appear stale to `rankOfflineEvents` and suppressing a timely candidate.

Exact-title grouping now verifies metadata identities again and partitions identical normalized titles into deterministic **all-member 48-hour windows**, matching the stricter time boundary already present in the SQL projection. An article can join only when it is within 48 hours of **every** member in exactly one matching group. Ambiguous matches stay separate; old and fresh repetitions do not merge. It does not fetch content, infer publisher independence, verify facts or authorize publishing.

The generated `exact-event-window-v2` IDs use the members' deterministic identities and are **not stable persisted event IDs**: they can change as members are added. SQL `research_events.event_id` remains the durable identity for live projection; this offline change does not rewrite stored rows. Synthetic tests cover recurrent titles, transitive 72-hour chains, forged IDs/hashes and a fresh headline that was previously hidden by an older exact-title match.

The outstanding #18 production acceptance still requires an approved end-to-end source-to-SQL-to-Admin proof; this patch alone is not a completed newsroom deduplication system.

## Canonical feed metadata parity (offline P2-03)

The offline `normalizeFeedArticles` boundary now rejects URL percent encoding, query strings, fragments, raw dot segments and noncanonical URL serializations, consistent with the guarded P2-02 PostgreSQL commit and the live poller's URL decoder. It also rejects leading/trailing headline whitespace, angle brackets and ASCII control characters (including DEL), consistent with live feed-title admission. These checks run before either offline exact-title or conservative lexical grouping; tests cover direct normalization and tampered records.

This prevents **offline** candidate pipelines from accepting article metadata that the real feed commit would refuse. It **does not** grant source/host rights, independently confirm publisher provenance, fetch full articles, normalize away tracking URLs, or rewrite any stored evidence. Actual URL ownership and current approvals are still enforced only through the reviewed source registry and guarded PostgreSQL functions. The source-to-SQL-to-Admin production acceptance of issue #18 remains open.
