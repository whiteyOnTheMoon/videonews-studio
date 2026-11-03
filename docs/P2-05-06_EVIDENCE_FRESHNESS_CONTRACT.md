# P2-05 / P2-06 — Offline evidence chronology and freshness contract

`gateOfflineClaimEvidence` validates synthetic review metadata without network or paid providers. It checks canonical UTC-millisecond timestamps, reviewer-id shape, the set of reviewed claims, repeated or extraneous evidence, source URL bindings, publication dates, review age and impossible time order. Expired articles, ambiguous records and unsupported claims yield explicit negative decision reasons.

**Security boundary:** a string `reviewerId` is **not** an authenticated editor, attestation or external independent verification. Even a clean offline check returns `ready: false` by design. No operator may promote this result into publishing authority. Real acceptance still requires personally authenticated independent reviewers, verifiable source rights, origin/syndication checks, durable versioned claim decisions, database audit, controlled freshness rechecks before release, and a separate operator deployment decision.

The tests use only synthetic metadata; no real feeds, paid provider requests, Docker or VPS mutations are performed. Outstanding #20 and #21 acceptance items therefore remain open.

## Canonical source identity and claim citations (P2-05/06 hardening)

The offline gate now independently recomputes the canonical source/article IDs and
headline fingerprints from the candidate event, instead of trusting a caller-provided
article ID, headline or URL merely because the separate review uses the same URL.
A fabricated event with a correspondingly fabricated review is marked
`event_metadata_mismatch`. Claims citing duplicate article IDs or IDs absent
from the event are separately marked `duplicate_claim_article_reference` and
`unknown_claim_article_reference`.

These checks **do not** establish the external article's authenticity, its
content, copyright permission, actual publisher independence, or an
authenticated reviewer's identity. The result is unconditionally
`ready: false`, including when the list of defects is empty. This change
does not fetch any source, create a PostgreSQL checkpoint, contact an AI
provider, or activate publication. Real independent source observation,
versioned reviewer credentials, evidence-content provenance and a controlled
live freshness recheck remain outstanding.
