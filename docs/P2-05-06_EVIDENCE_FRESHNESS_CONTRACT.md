# P2-05 / P2-06 — Offline evidence chronology and freshness contract

`gateOfflineClaimEvidence` validates synthetic review metadata without network or paid providers. It checks canonical UTC-millisecond timestamps, reviewer-id shape, the set of reviewed claims, repeated or extraneous evidence, source URL bindings, publication dates, review age and impossible time order. Expired articles, ambiguous records and unsupported claims yield explicit negative decision reasons.

**Security boundary:** a string `reviewerId` is **not** an authenticated editor, attestation or external independent verification. Even a clean offline check returns `ready: false` by design. No operator may promote this result into publishing authority. Real acceptance still requires personally authenticated independent reviewers, verifiable source rights, origin/syndication checks, durable versioned claim decisions, database audit, controlled freshness rechecks before release, and a separate operator deployment decision.

The tests use only synthetic metadata; no real feeds, paid provider requests, Docker or VPS mutations are performed. Outstanding #20 and #21 acceptance items therefore remain open.
