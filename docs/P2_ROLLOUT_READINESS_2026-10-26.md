> **Betreiberstand 28.10.2026:** Der Betreiber bestätigt bestehende regelmäßige
> IONOS-Backups und funktionierendes Beszel-Monitoring. Diese spätere Bestätigung
> ersetzt die historische Entscheidung vom 27.10.2026, vorerst ohne Backups
> zu arbeiten. Kein neuer Backup-Dienst, kein IONOS-Umbau und keine zusätzliche
> allgemeine Monitoring-Infrastruktur sind beauftragt. Ein unabhängiger
> Restore-Nachweis und P2-spezifische Feed-Alarme sind dadurch **nicht**
> geprüft. Siehe [historische P1-Entscheidungen](P1_OPERATOR_DECISIONS_2026-10-27.md)
> und [P2-02-Nachweise](P2-02_IONOS_BESZEL_ACCEPTANCE_2026-10-27.md).
>
> **Unverändert:** Kein kostenpflichtiger GitHub-Branchschutz; dies ist als
> manuelle Governance-Ausnahme akzeptiert. Beszel genügt als allgemeines
> P1-Monitoring. Neue P2-Feed-Dienste brauchen eigene technische Abnahme,
> wenn sie aktiviert werden.

# Phase 2 — Offline acceptance and rollout preparation

**Operator update 2026-10-27:** Recurring backups by IONOS and normal operation
of the existing Beszel monitoring are reported. The former backup-free
experiment is no longer the desired operating model. Nevertheless, P2-02
production approval still requires verification of IONOS backup coverage,
a non-destructive isolated restore and a specific feed-health alarm delivery
witnessed by the operator. See [IONOS/Beszel evidence checklist](P2-02_IONOS_BESZEL_ACCEPTANCE_2026-10-27.md).

**Status: NOT RELEASED / BLOCKED.** This runbook is an operator checklist and is not permission to touch the VPS or activate feeds, Docker services or AI calls.

## Evidence levels

- **CI passing:** Compiles and passes synthetic/unit/disposable integration checks; does not establish productive correctness.
- **Offline integration passing:** Real disposable PostgreSQL/Redis endpoints and simulated feed responses; no live sources, rights or production data.
- **Operational acceptance:** Independently authorized real source license/ToS and minimum polling intervals, personally bound database writers, independent trust anchors and signer custody, protected governance, restore and real alert delivery.
- **Rollout authorized:** Operator has explicitly approved a specific commit, deployment plan, source set, configuration, database migration and rollback strategy. This approval is separate from GitHub merges.

## Mandatory checks before any VPS change

1. Confirm SHA and intended release images by immutable digest; validate no secrets in repository or GitHub logs and no unreviewed host or sources.
2. Resolve GitHub visibility/protection decision (#2) without unilateral changes or paid upgrades.
3. Verify source-admin and host-admin separate named database login credentials, independent human reviewers, immutable audit, revocation and concurrent mutation denial (#16).
4. Provision and independently test server-enforced source and signing-trust high-water authority, Ed25519 public-key epoch policy, private key custody/rotation and recovery. Do not treat a same-host database as independent.
5. Establish an operator-approved offsite backup/restore alternative and validate actual restore (#228), or explicitly accept documented data-loss risk for a **nonproductive** test deployment only.
6. Verify Redis queue isolation, idempotent claims, DB migration rehearsals, rollback preconditions and no queue auto-start.
7. Verify actual licensed 3–5 sources, feed schemas, cache/rate limits and audit of ETag/304/failed polls. Do not query real providers before rights review.
8. Verify dynamic niche/language/risk/source approval configuration in authenticated Admin UI, and immutable version/audit history.
9. Verify event de-duplication using publisher syndication examples; ranking explanation; evidence freshness and independent review; script formats, bounded revision attempts and independent quality gate. No automatic publication on uncertain evidence.
10. Verify production timeline export (sources, source licenses, approvals, all claim decisions, rejected statements, script revisions, editor identities and timestamped transformations).
11. Prove Beszel and application alarms actually deliver to operator (#229); record drill results.
12. Obtain explicit separate operator authorization for **every production VPS/Docker change**, any real feed access and paid provider call. Confirm rollback decision owners.

## Safe staged sequence (only after authorization)

- **Stage A:** Read-only preflight and immutable release inventory. Fail closed if any evidence unknown.
- **Stage B:** Separate credential and backup preparation by authorized operator, offsite recovery drill. No service activation.
- **Stage C:** Migrations on a disposable mirror; compare schema and rights, rehearse rollback and full restore.
- **Stage D:** Controlled deploy to separate inactive containers with zero scheduler/worker production gates. Check health and admin sessions.
- **Stage E:** After a distinct source/rights approval, manually run a single limited feed observation, verify DNS, ETag, DB, queue and audit evidence. Keep auto-scheduling disabled.
- **Stage F:** Explicit activation authorization for bounded scheduler; verify limits, error states, alarms and automatic stop conditions.
- **Stage G:** Editorial review and publication remain disabled until independent verification, costs and license approvals are proven.

**Rollback:** Immediately disable scheduler/worker gates; do not drop existing data or reset monotonic anchors. Revert container images only to audited digests compatible with schema and independently anchored revision floor. If uncertain, keep services stopped and restore from independently verified backups using a separate approved recovery procedure.

## Machine-readable gate

`node scripts/p2_rollout_gate.mjs path/to/operator-evidence.json` runs read-only, without network. Schema: `{"schemaVersion":1,"mainSha":"40-character-sha","evidence":{"requirement":{"status":"passed","approver":"named-reviewer","reference":"https://...","approvedAt":"ISO-Z"}}}`. Every requirement enumerated in `REQUIREMENTS` must have a documented operator-reviewed reference. This checks manifest completeness and shape **only**, not authenticity of references, and never deploys or replaces explicit rollout permission.

**Current result:** Many requirements remain open. Do not fabricate checkmarks or close P2 issues on CI evidence alone.

## SHA-bound offline evidence validation (26 October 2026)

Run `node scripts/p2_rollout_gate.mjs evidence.json EXPECTED_40_CHAR_RELEASE_SHA` with the **immutable intended release commit**. The evidence document's `mainSha` must match; moving `main` or replaying an old manifest must not silently satisfy the checklist. Omitting the second argument is maintained for legacy offline checks, **not suitable as the SHA-bound final release check**.

Approval timestamps must be valid UTC calendar instants, not future-dated. Review URLs must be HTTPS without embedded credentials, fragments or loopback/internal hostnames. The gate checks only format and local consistency: it **cannot independently confirm approvals, identity, restored data, licenses, repository protection or signatures**. A successful exit code does not authorize deployment. On any discrepancy, stop before touching the VPS.

**Remaining blockers:** #2, #16–#25, #227–#230; also no deploy authorization, no source rights, no key custody/independent anchor, no demonstrated live restore or Beszel alert delivery. Do not mark any of these complete solely through this gate.
