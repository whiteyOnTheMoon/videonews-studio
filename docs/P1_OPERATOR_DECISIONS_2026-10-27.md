# Phase 1 — binding operator decisions (27 October 2026)

> **Later operator status, 28 October 2026:** The operator subsequently
> reconfirmed that IONOS backups are in place and the existing Beszel
> monitoring works for VideoNews Studio. This supersedes the **backup-free
> operating preference** recorded below, which remains preserved as a
> historical 27 October risk decision. No new backup service, IONOS setting,
> paid subscription or duplicate monitor is authorized by this update.
> Backup **coverage, isolated recovery and feed-specific alert delivery**
> have not been independently demonstrated; do not mark those tests passed.
> See [the P2-02 verification record](P2-02_IONOS_BESZEL_ACCEPTANCE_2026-10-27.md).

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

## P1 backup policy: zero backup budget

**Operator decision 27 October 2026 (latest, superseding the earlier IONOS-backup report):** For the time being, **no backups will be created for VideoNews Studio because of cost**. Do not order, install, configure, schedule or execute backups and do not assume the provider's backup service covers VideoNews Studio. No automatic backup onboarding, additional offsite storage or backup charges. The operator explicitly accepts the possibility of permanent loss of experimental PostgreSQL, Redis/BullMQ, configuration and other non-recoverable data while working under this exception.

This is a **risk acceptance, not a successful backup or restore test**. Keep the backup/restore requirement as deliberately deferred/not planned for the current Phase-1 experimental scope; do not mislabel recovery gates or simulate evidence. Any later production workflow involving irreplaceable content, secrets or irreversible side effects must reassess data loss, recovery and key custody before enabling it. Later Phase-6 recovery tests remain distinct from this P1 decision. Do not modify the server or existing IONOS account on the basis of this documentation.

## Distinct concerns remain

The latest operator decision explicitly postpones VideoNews Studio backups; isolated restoration remains untested (#228). Productive provider-key access (#227) and actual provider-usage/job-cost measurements (#230) have not yet been accepted. These decisions do not authorize billable external calls, real feed activation or a VPS deployment.

Historical documents and issue descriptions may describe earlier constraints; this dated operator decision supersedes them **only** for GitHub-paid-protection policy and baseline Beszel monitoring acceptance.
