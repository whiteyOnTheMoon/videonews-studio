> **Neueste Betreiberentscheidung 27.10.2026 (Vorrang vor historischen IONOS-Angaben):** Für VideoNews Studio werden vorerst **keine Backups erstellt**, Kostenbudget dafür **0 €**. Das Risiko eines dauerhaften Datenverlusts im experimentellen Betrieb ist ausdrücklich akzeptiert. Keine Sicherung, kein Restore und keine produktive Wiederherstellbarkeit werden dadurch als nachgewiesen betrachtet. Keine Backup-Dienste aktivieren oder IONOS konfigurieren. Siehe [verbindliche P1-Entscheidungen](P1_OPERATOR_DECISIONS_2026-10-27.md).\n\n# P2-02 — IONOS backup and Beszel acceptance update (2026-10-27)

**Status: OPERATOR REPORTED / NOT YET INDEPENDENTLY VERIFIED.**
On 2026-10-27 the operator reported that **IONOS now performs regular backups** and that **Beszel works correctly**. This supersedes the historical preference to operate without backups. It does **not** prove that the existing backups include the complete VideoNews Studio recovery set or that P2-02-specific alerts have been delivered.

**Decision:** Reuse the existing IONOS backup arrangement and Beszel monitoring. Do not provision an additional restic/Cloudflare/Google/storage subscription, create duplicate backup jobs, enable real feeds or change Docker/VPS credentials merely to satisfy this document. The installed provider's backup type/plan, permissions, schedule, retention, cost, encryption and evidence remain to be verified by the operator.

## Distinguish backup mechanisms before assigning readiness

IONOS product documentation distinguishes (depending on the server product) snapshots, server images and managed backup packages. These differ in coverage and retention. **Do not assume that "IONOS backups enabled" implies an application-consistent PostgreSQL/Redis backup, separate recovery location, a particular retention period or a non-destructive restore option.**

Provider information to review, not a claim about this installation:

- [IONOS: Snapshot vs image vs backup package](https://www.ionos.com/help/server-cloud-infrastructure/general-information/differences-between-a-snapshot-an-image-and-a-backup-package/)
- [IONOS: Backup packages and protected data categories](https://www.ionos.com/help/server-cloud-infrastructure/cloud-backup/important-backup-package-information/)
- [IONOS: Restore options](https://www.ionos.com/help/server-cloud-infrastructure/cloud-backup/restoring-backups/)

## Operator review — read-only, no secret disclosures

| Check                                   | Needed evidence (retain privately)                                                                                                                        | Status            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| IONOS product type and protected server | Backup package/image/snapshot or other, correct VPS identification                                                                                        | Unknown           |
| Schedule and last successful execution  | Actual success record and exact timestamp; no assumptions from toggle or subscription                                                                     | Unknown           |
| Covered data                            | Includes `videonews-studio_postgres_data` and `videonews-studio_redis_data` under /var/lib/docker and any media/audit/configuration needed for recovery   | Unknown           |
| Database consistency                    | PostgreSQL 17 and Redis 7 AOF/BullMQ backup method and correctness under live writes; crash-consistent storage copies may need application-level recovery | Unknown           |
| Off-VPS access and retention            | Independently accessible recovery copy, age, storage location, retention and immutable/isolated access controls                                           | Unknown           |
| Recovery access and confidentiality     | Separate authorized recovery identities, encryption status, key custody, availability on total VPS loss                                                   | Unknown           |
| Full restore rehearsal                  | Recovery of PostgreSQL globals/ACLs/schema/data and Redis AOF/queue in isolated, **nonproduction** recovery target                                        | Not performed     |
| Outbox/BullMQ reconciliation            | No doubled research/work or accidental publication; workers kept disabled throughout restore drill                                                        | Not performed     |
| RPO/RTO                                 | Measured last restorable recovery point and elapsed restore time with operator-approved objectives                                                        | Not measured      |
| Beszel shared-host health               | Existing agent/hub and notifications working as reported by operator                                                                                      | Operator reported |
| Beszel P2-02 feed health                | `feed-consumer` and `feed-producer-continuous` appear once deployed, unhealthy/exited conditions detected and actionable                                  | Not demonstrated  |
| Beszel notification receipt             | Non-disruptive test alert for intended P2-02 condition received by operator, time and signal recorded                                                     | Not demonstrated  |

**Never** place backup-console credentials, customer IDs, private keys, restore links, notification URLs, database dumps, file lists containing personal data, or IONOS login exports into GitHub issues, CI, chat messages or screenshots. Evidence links in the release checklist should point only to sanitized operator-reviewed summaries.

## Recommended acceptance sequence

1. In the existing IONOS console (no restore click), verify backup mechanism, protected server, last success, schedule, covered drives/data paths, retention, encryption/recovery controls and recovery points. If any are unknown, leave the corresponding P2 gate blocked.
2. Do not install backup agents or modify backup jobs unless the already-running service demonstrably excludes critical state and a new, separately approved remediation is needed.
3. Operator arranges a **non-destructive isolated restore** with IONOS functionality appropriate to the product. A full-server restoration to the current VPS is prohibited as a test. If only destructive restore is offered, stop and establish a safer isolated recovery option before proceeding.
4. In the isolated target with ingress, scheduled feeds, publishing and workers disabled, verify PostgreSQL roles and data, Redis persistence/queues, signed audit integrity, configuration/media custody, and explicit queue/outbox reconciliation. Record actual elapsed RTO and recovery-point age for RPO.
5. Keep existing Beszel Hub and Agent unchanged. Verify their current host alarms, and on a separately approved inactive P2 test stage detect the specific producer/consumer container health transitions. Witness delivery to the intended operator using a safe Beszel-supported test or non-disruptive synthetic condition.
6. Attach only sanitized independent results to `#17` and the SHA-bound release evidence. Do not close P2-02 or mark `postgres_restore`, `redis_recovery` or `alert_delivery` passed merely because the provider console says a backup exists or Beszel is generally healthy.
7. Recheck the intended production release SHA, roles, approved 3–5 feed sources and publisher trust before an independently approved canary; leave the continuous feed scheduler disabled until then.

## Latest known VPS context

Operator read-only inspection reported PostgreSQL and Redis both healthy, volumes `videonews-studio_postgres_data` and `videonews-studio_redis_data`, 23 GB free on root (81% used), and no active P2-02 separated feed containers. The local VPS source commit was `3728a97589051fe0b028aa8ad07cf1aead0195b2`, behind GitHub `main`. These observations are **not** a verified inventory of what IONOS backs up.

**Release decision:** software/CI work may continue, but P2-02 production acceptance remains blocked until actual coverage, independent recovery and feed-specific alert delivery are witnessed. No provider invoice, restore, server change or recurring task was created by this update.
