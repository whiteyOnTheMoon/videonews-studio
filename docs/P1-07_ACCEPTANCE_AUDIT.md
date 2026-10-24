# P1-07 acceptance and rollout gap audit (2026-10-24)

**Status: code/CI substantially implemented; operational acceptance NOT complete.**
This document tracks the original [P1-07 delivery issue](https://github.com/whiteyOnTheMoon/videonews-studio/issues/7) and the [authenticated data-stack rollout issue](https://github.com/whiteyOnTheMoon/videonews-studio/issues/87). A green CI build is *not* approval to start data services on the VPS.

## Evidence available in the repository

- Separate editor API and browser-side authentication, roles and session revocation are behind explicit disabled-by-default feature gates. PR #106 introduced the browser integration. PR #126 fixed the success message to depend on a verified personal session and was merged after green CI under an **operator-authorized one-time independent-review exception**.
- The protected research-job submission design and existing BullMQ/dispatcher integration are exercised by GitHub Actions against disposable infrastructure. In `apps/worker/src/queue.ts`, the runnable Worker explicitly accepts **only `probe` jobs** with exactly `{ kind: "probe" }` and rejects research, rendering, upload and editorial workloads; concurrency is fixed at 1. The queue and database must not be described as running on the live VPS merely because CI executes them.
- The [full recovery runbook](P1-07_RECOVERY_RUNBOOK.md) describes the PostgreSQL restore, read-only PostgreSQL/Redis reconciliation audit, Redis AOF recovery rehearsal, and unresolved production recovery approvals.
- The [recovery component inventory](P1-07_RECOVERY_INVENTORY.md) enumerates 22 recovery dependencies and Compose resource drift checks. These are repository/CI evidence, **not** verified live state.

## Acceptance matrix

| Criterion | Verified scope | What remains before issue closure |
| --- | --- | --- |
| Durable jobs, bounded retry/backoff, idempotency and failure visibility | Implemented persistence/dispatch and synthetic CI integrations; the runnable BullMQ handler is probe-only | Confirm bounded attempts, restart behavior, duplicate side effects and failure presentation against the **approved deployment**; real editorial job processing is explicitly outside the current worker |
| Controlled recovery of interrupted jobs / no infinite retries | CI-only worker and recovery exercises | Approve reconciliation and operator restart procedure on an independently restored dataset; record actual stop/restart results |
| Automated tests | Existing monorepo, worker, database and recovery workflows | Preserve latest-head green status after future changes, and attach the specific run IDs to final acceptance |
| Documentation | Runbooks, role boundaries, worker instructions and repository inventory | Review actual live deployment settings and replace planning assumptions with operator-verified evidence |
| PR review and merge governance | #126 merged with explicit, documented single-PR review exception | Require independent review for new PRs unless the operator grants a separate explicit exception |
| Authenticated PostgreSQL + Redis rollout | Compose design and isolated CI fixtures | Reviewed backup/recovery policy, actual operator-approved secret/credential setup, VPS resource preflight and explicit activation approval |
| Real restore and continuity | Disposable synthetic PostgreSQL/Redis and cryptographic exercises | Independent off-host backup, trust/key custody, timed full restore and recovery signoff |
| Named editor lifecycle and audit | Offline role and identity controls tested | Approved real account onboarding, operator authorization, credential custody and independent audit retention |

## Stop conditions

Do not turn on `data`, `worker`, `ingress`, personal-editor or source-review production flags based on this document. Do not create accounts, credentials, paid storage, or deploy/modify VPS containers without **separate, specific operator approval**. Preserve existing live services and Cloudflare settings. An independent backup location and budget, RPO/RTO, retention/privacy rules, encryption and signing trust custody, restored media inventory and external publication safety remain undecided as detailed in the recovery runbook.

## Next actions

1. Keep the currently merged editor-login fix as the baseline; avoid reusing the obsolete feature branch.
2. Review concrete P1-07 acceptance evidence against all latest-head CI runs. Specifically verify that an unsupported worker job reaches the terminal failure path under bounded attempts without side effects, rather than implying that the probe worker performs editorial processing.
3. Open focused PRs for independently testable gaps and require CI and review.
4. Separately ask the operator to decide backup destination/cost, RPO/RTO and VPS rollout only when a safe, actionable proposal is available.
5. Close issues #7 and #87 only once their *operational* acceptance evidence has been recorded. Never mark release gates as satisfied merely from documentation.
