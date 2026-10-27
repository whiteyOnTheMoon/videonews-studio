# P1 final acceptance and controlled rollout gates — 2026-10-27

Relates to #227 and #230. This document records the live production blockers against the current `main` baseline; **it does not report an unperformed VPS rollout**.

## Operator decisions (authoritative)
- No paid GitHub branch-protection upgrade; manual PR/head-CI/approval policy.
- Existing Beszel and external monitoring accepted for P1.
- **No VideoNews Studio backups** for now, 0 EUR backup budget; experimental data-loss risk accepted. No backup claim or restore success may be inferred.
- No unauthorized paid provider requests and no secrets in GitHub, chat, CI, logs or fixtures.

## #227 — secret management acceptance

Currently `apps/api/src/index.ts` does **not** inject `providerConfig`; `apps/web/src/app/api/admin/ai-providers/route.ts` implements **GET only**. The optional provider master-key loader requires owner-private binary key storage; the personally audited DB mutation adapter is not mounted. The visible Admin editor remains disabled.

### Conditions before enabling write endpoint
1. Dedicated least-privilege DB LOGIN and scoped pool on target VPS with migrations/ACLs proved on the actual deployment.
2. Real named session from browser through BFF, API and SQL, with audit written atomically and CSRF, revoked-session and spoofing negative tests.
3. KEK custody: loss, rotation, file rights and restart behavior validated without disclosing key material. Under the no-backup policy, irreversible loss of a single encryption key means provider credential ciphertext is unrecoverable; require explicit acceptance or an independent approved recovery design **before receiving any valuable production API key**.
4. POST endpoint + Admin UI enabled only behind an explicit default-off toggle, with rate gate, rollback, and tested denial semantics.
5. Provider/model choices supplied by reviewed configurable policy, not an unreviewed hardcoded production list.
6. Named operator records the rollout SHA, negative tests and reversible activation decision.

## #230 — real provider usage acceptance

`apps/worker/src/token-usage.ts` and migration 0013 are **synthetic only**. PR #299 introduced a pure parser/reconciliation contract, not a provider adapter or live billing ledger.

### Conditions before claiming measured costs
1. Strict per-provider adapter for actual response metadata (including caching, missing/late fields, retries, partial failures and non-text modalities).
2. Versioned pricing and original request identity, with DB uniqueness, serializable/resilient upsert and immutable audit.
3. Atomic reconciliation to reserved job budgets; missing/conflicting usage must refuse further spend.
4. Tested job/day/month caps (related future P6-06 #60), including exhausted limits and recovery.
5. A separately approved capped real-provider canary to compare the provider's reported usage with persisted receipts. No live canary without provider credentials/budget consent.

## Deployment vs code merge

- P1's **existing experimental probe-only deployment** is historically reported; no new API/DB/worker deployment is proven by this GitHub review.
- Default-off offline code may be merged and tested without enabling secrets, external calls or video production.
- Do not close #227 as `completed` while write path and named deployment aren't proven.
- Do not close #230 as `completed` while real usage ingestion, durable budget accounting and provider-verified result aren't proven.
- If the operator formally changes scope to experimental/no-paid-provider only, track remaining production features as separate follow-up issues and state that scope change explicitly. A smaller P1 closeout is not equivalent to production readiness.

## Read-only evidence collection for controlled rollout

On the VPS, with no changes to other projects, confirm Git `main` SHA, tree cleanliness, Docker Compose service health and migration version. Keep current research, provider mutation, paid AI and publication toggles disabled. Never print environment secrets or any encryption keys. Record only sanitized results, operator-approved time and rollback plan. Deployment modifications require access to the server and a separate preflight of their actual effects.
