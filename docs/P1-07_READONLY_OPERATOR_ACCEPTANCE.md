# P1-07: Repeatable read-only operator acceptance (2026-10-25)

**Scope:** A repeatable observation of the existing **probe-only** VPS deployment, **not** a complete P1-07 editorial service acceptance. This document does not authorize a restart, a new probe job, any dispatcher/status-sync activation or a production render/research/upload.

## Preconditions

- Operator is on the original Ubuntu VPS, in `/home/ap/www/videonews-studio`, on reviewed `main`, with a clean Git worktree; no unpublished local changes.
- No concurrent experimental redeployment. Expected Compose project is `videonews-studio`.
- Existing credentials remain only in mounted Docker secret files; do not print or copy them.
- This is a **read-only** check. If any precondition fails, stop; do not repair by restarting containers, deleting jobs, modifying ACLs or pruning images.

## One permitted read-only command

```bash
(
  set -euo pipefail
  cd /home/ap/www/videonews-studio
  test "$(git branch --show-current)" = main
  test -z "$(git status --porcelain)"
  git rev-parse --verify HEAD
  bash scripts/p1_07_live_probe_receipt.sh
)
```

The existing script checks isolated worker/Redis identity, worker image provenance, expected retained **single-use** probe receipt, authenticated Redis access, healthy PostgreSQL/Web/API and unchanged empty editorial SQL baseline. It **does not enqueue** another probe and does not start or restart services. Its exact expectation of eleven migrations and zero editorial jobs/outbox/operator rows is intentionally conservative; changed legitimate data requires revising the acceptance baseline separately, not suppressing failures.

**Evidence to retain:** date/time, Git SHA, PASS/REFUSED lines, zero-secret sanitized terminal transcript and who observed it. Never infer that checks passed unless the operator actually supplies successful terminal output.

## Acceptance classification

| Requirement                                             | Evidence class                               | Status                                                             |
| ------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| Existing isolated probe-worker and Redis/PG baseline    | Previously observed operator terminal output | Previously passed; repeat check not yet executed for this document |
| Deterministic Outbox dispatch and status reconciliation | Disposable GitHub Actions integrations       | CI tested; neither process running on VPS                          |
| Bounded retry, lost-ack, Redis loss, retained failures  | Disposable CI only                           | No live crash/restore acceptance                                   |
| Editorial research, script, render, upload              | Probe worker refuses these kinds             | Intentionally disabled; no live acceptance                         |
| Offsite backups and DB/Redis restore                    | No independently verified original           | Open, tracked under P1-09 #9                                       |

## No-go conditions and closure rule

Keep P1-07 #7 and rollout #87 **open** until the operator explicitly approves a sufficiently protected live editorial processing design and the relevant real end-to-end evidence is collected, or formally accepts a **clearly documented scope reduction** making probe-only infrastructure the sole P1-07 deliverable. A green CI workflow or this read-only receipt alone cannot substitute for live Outbox/status service acceptance. Do not activate a dispatcher against the probe-only worker: unsupported job types would enter the queue. No automatic publication and no new paid services.
