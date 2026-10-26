# P2-02 to P2-10 — Synthetic candidate handoff test

`apps/worker/src/feed-queue-scheduler-e2e.test.ts` now exercises an operator-gated, configured three-source feed tick through a pinned-HTTPS **mock**, SQL-claim/commit **mock**, isolated queue **mock**, canonical article metadata normalization, conservative event candidates, profile ranking, draft creation, separate conservative evidence checks and an unpublished editorial report. Cached 304 and replay/duplicate controls are still tested. No headlines become factual evidence solely because their metadata agree.

**Evidence tier: synthetic integration only.** These mocks do not replace the independently required full disposable PostgreSQL/Redis integration, publisher provenance checks, real personally authenticated database read/write path, licensed external source acceptance, durable event persistence, human claim verification, immutable production timeline or VPS rollout. `approvedForPublication` and evidence `ready` remain `false`. No source polling, scheduling, spending or production migration has been enabled.

P2-01 through P2-10 remain subject to their respective original issue acceptance checklists and the separate operator rollout approval.
