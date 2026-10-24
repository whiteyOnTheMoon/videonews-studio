# P1-07 — Operator backup and rollout decision brief

**Status: proposals only; no selected destination, expenditure, backup run, restore, or VPS authorization.** This brief turns the existing [recovery runbook](P1-07_RECOVERY_RUNBOOK.md) and [key custody design](P1-07_BACKUP_KEY_CUSTODY.md) into concrete, separately approvable options. All twelve release gates in [the recovery plan](p1-07-recovery-plan.json) remain **false**.

## Constraints and options

| Option                                            | Recurring storage expense                                                                                          | Independence from complete VPS loss                                              | Suitability                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A — GitHub source only, no new backup             | No new backup expense                                                                                              | **No**: code exists, PostgreSQL records/Redis/media/keys do not                  | Keep P1-07 data and worker profiles disabled; **not** an approved production backup                                              |
| B — Independently owned offline encrypted storage | May avoid a new subscription if suitable storage already exists; hardware, maintenance and access still have costs | Potentially yes if stored off-VPS with independent credentials/keys              | Conditional candidate; operator must approve ownership, physical/geographic risk, retrieval, privacy and realistic restore tests |
| C — Independent off-host managed storage          | Depends on provider, usage, retrieval/egress and retention terms; **no price assumed**                             | Potentially yes with independently controlled account, keys and verified restore | Conditional candidate; requires a specific provider quotation and explicit spending authorization                                |

**Do not store the only backup on the same VPS, solely in Docker volumes, inside a GitHub repository or in GitHub Actions artifacts.** None provides a verified independent, accessible recovery copy. Do not use Cloudflare Tunnel source credentials or the application's live secret files as part of a public archive.

## Decision record — every field requires explicit operator input

| Field                                       | Current value                             | Required proof before activation                                                                                       |
| ------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Backup destination and owner                | Undecided                                 | Independent off-VPS access, restore permissions and recovery-access check                                              |
| Monthly/yearly budget ceiling               | Undecided                                 | Signed-off storage, transfer, key and verification costs, including possible zero-subscription costs                   |
| RPO / lost-data tolerance                   | Undecided                                 | Maximum permissible loss for job ledger and audit events, matched by actual capture frequency                          |
| RTO / restoration deadline                  | Undecided                                 | Timed end-to-end rehearsal on an isolated recovery target                                                              |
| Backup schedule and retention               | Undecided                                 | Policy with deletion/privacy and immutability considerations                                                           |
| Key custody and lost-key contingency        | Undecided                                 | Separately protected decryption keys, signing trust root, rotation and recovery procedure                              |
| Data classification and volume sizes        | Unknown on real VPS                       | Operator-reviewed PostgreSQL, Redis AOF, media, audit, credential and external configuration inventory                 |
| Full-stack restore and queue reconciliation | Not performed on real independent backups | Proven independent PostgreSQL roles/data, media, audits, Redis decision, no duplicate side effects and stopped workers |
| Cutover and rollback authorization          | Not granted                               | Fresh specific operator approval after all evidence, with publication/ingress disabled until signed off                |

## Proposed staged approval sequence

1. **Design only (current):** review this brief and existing runbooks in GitHub without contacting real infrastructure. Do not alter machine-readable gates.
2. **Operator option selection:** explicitly choose A (continue disabled) or request a separate concrete proposal for B/C; specify cost ceiling, RPO/RTO, retention and custody requirements. Selecting an option is not permission to provision anything.
3. **Preflight proposal (new approval required):** inventory real VPS resource sizes, data classes, current Docker volumes, identities, Cloudflare dependencies and credentials without copying secrets to GitHub. Define access boundaries and rollback. Explicit authorization is required even for read-only access to the VPS.
4. **Separate backup implementation authorization:** only after the budget, independent destination, encryption, credential custody and privacy policy are approved may a narrowly scoped implementation proceed. Never change live services solely based on green CI.
5. **Independent restore signoff:** verify provenance/freshness off-VPS; restore onto an isolated target with no external publication, confirm PostgreSQL ACLs/audits, Redis/PG reconciliation, media hashes, identities and safe stopped worker behavior; measure RPO/RTO and record evidence outside sensitive repo content.
6. **Separate production activation authorization:** approve precisely named Compose profiles/services and rollback window only after all gates are satisfied. Recheck current deployment instead of assuming GitHub's Compose template matches it.

## Practical next decision

If avoiding backup expense remains the priority, **choose A and continue with worker/data services OFF**. This is cost-conserving but explicitly does **not** complete production P1-07. Options B and C should only be evaluated after the operator supplies an independently controlled storage candidate and acceptable costs. There is no justified assumed free quota, provider price or safe RPO/RTO.

See the [22-component recovery inventory](P1-07_RECOVERY_INVENTORY.md) for scope. This document does not grant a production release or supersede the recovery plan.
