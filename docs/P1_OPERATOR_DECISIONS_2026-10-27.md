# Phase 1 — binding operator decisions (27 October 2026)

## P1-02: GitHub governance without paid branch protection

The operator explicitly chooses **no paid GitHub branch protection or plan upgrade**. The existing repository remains in its present visibility state; do not change visibility or subscription to enable protection. This is an **accepted, documented governance exception**, not an assertion of technical enforcement.

Compensating manual controls for all future changes:

1. Create or reference a traceable issue before implementing a change.
2. Work on a separate feature branch and propose changes through a pull request.
3. Inspect the PR diff and its issue reference; obtain operator approval for merges and security-sensitive release decisions.
4. Require relevant GitHub Actions checks to have completed successfully on the current PR head **before merging**, as a manual rule. Do not claim these checks are GitHub-enforced required statuses.
5. Record the approval, CI evidence, merge commit and any exception in the PR/issue. Do not claim an independent human reviewer participated unless one actually did.
6. No force push to `main`, no direct push as the normal workflow, no unapproved paid plan, no automatic approval of deployment, services, credentials or external feeds.

The repository has templates, CODEOWNERS and PR metadata/CI workflows. They help review but cannot replace server-side protected branch policies. The owner explicitly accepts this residual risk for phase 1; **P1-02 may be closed as an operator-approved process exception** when this decision is merged.

## P1-09: Beszel monitoring accepted

The operator explicitly confirms that the existing Beszel installation works as server-wide monitoring, with the server also monitored externally. **Accept the existing monitoring arrangement for Phase 1 as fulfilled, on operator attestation.** Do not require an additional Beszel installation, dedicated VideoNews monitoring stack, or a new generic alert drill to close P1-09-FU #229.

No new test alert, alert-receiver evidence, synthetic failure, or container restart is required **for this scoped Phase-1 monitoring acceptance**. Previous checklist items in #229 are waived as separate Phase-1 gates by the operator; do not falsely mark them as tested. Beszel does not provide provider token accounting, PostgreSQL/Redis backup restoration, or evidence of application-specific feed-processing health. New P2-only producers/consumers must still be observed **when deployed** as part of the applicable P2 integration acceptance; do not reopen general Beszel adequacy or require parallel monitoring infrastructure.

## Distinct concerns remain

IONOS regular backups have also been affirmed by the operator, but isolated database restoration is a different criterion (#228). Productive provider-key access (#227) and actual provider-usage/job-cost measurements (#230) have not yet been accepted. These decisions do not authorize billable external calls, real feed activation or a VPS deployment.

Historical documents and issue descriptions may describe earlier constraints; this dated operator decision supersedes them **only** for GitHub-paid-protection policy and baseline Beszel monitoring acceptance.
