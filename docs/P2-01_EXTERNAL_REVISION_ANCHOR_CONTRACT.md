# P2-01 — Independent monotonic revision anchor (offline contract)

This change introduces an optional offline acceptance hook `IndependentSourceRevisionAnchor.advance(candidate)` in the unmounted worker source-export verifier. The hook runs **after** signature/host-policy/checkpoint checks but **before** the local checkpoint is persisted or source records are returned. Failure rejects acceptance and does not advance the local checkpoint. Synthetic tests cover joint rollback of the signed export and local checkpoint, as well as anchor failure.

## Production contract (not implemented or approved here)

- The anchor must be provisioned outside the worker/publisher filesystems and outside their shared rollback/failure domain, with independently managed access controls. A second file, container volume, or DB table accessible to the same rollback administrator does **not** satisfy independence.
- `advance` must be a **durable linearizable atomic compare-and-advance** operation across concurrent workers: refuse a lower source revision **or** lower host approval revision; refuse a different SHA-256 envelope digest when both revisions match; permit exact idempotent replay. Reject malformed inputs, missing initial state without operator-authorized bootstrap, unavailable storage, timeout, unknown commit outcome, or permission failures (fail closed).
- Only trusted service identity may advance state; readers cannot reset it. A separate authorized operator recovery protocol must investigate disagreement and record approval before any rollback/reset. Key rotation must preserve revision continuity.
- The publisher/worker must never accept an anchor implementation based only on their own local checkpoint. The in-memory test double is deliberately **not a production store**.
- Bootstrap authorization, physical independence, atomic concurrency, authorization, disaster recovery, observability, and loss-of-connectivity behavior require separate acceptance evidence. No implementation in this PR supplies these.
- The hook is intentionally optional solely to preserve existing dormant/offline callers. **Production code must always supply a verified independent anchor**, and should remove the optional bypass when mounting the consumer. The current worker entrypoint does not call this module.

## Boundaries

No new secrets, deployment mounts, network requests, DB credentials, scheduler/feed activation, costs, or production VPS changes. This is a narrow testable admission contract, **not completion of #16** or an independent production anti-rollback guarantee.
