# P2-04 / 0065 source-link inbox – controlled operator schema gate

## Scope

`scripts/p2_04_schema_0064_to_0065.py` is a **fail-closed, default read-only** operator gate for the *existing* `0065_named_feed_inbox_sources.up.sql` migration. The change adds only a personally bound original-article URL reader; no feed runs, publishing, rendering, source approvals, or current private preview paths are modified. The prior `0063_named_feed_inbox_page(integer)` reader and P3 asset provenance catalog remain unchanged.

- `--status --expected-sha SHA`: inspect exact pristine pinned `main`, existing healthy PostgreSQL, the 65-file ordered migration inventory, schema ledger and role-specific permissions; report 0064 or 0065 state.
- `--preflight --expected-sha SHA`: read-only admission on exactly schema 0064, including an exact on-disk `0065` migration check against pinned tracked Git content, schema privileges and a private hash/count snapshot. Does **not** apply migrations.
- `--apply --expected-sha SHA`: **never authorized by merging this PR**. Requires a separate explicit VPS operator approval and verified restorable backup, plus three exact environment acknowledgments `VNS_P2_0065_SCHEMA_OPERATOR_APPROVED=INSTALL_ORIGINAL_SOURCE_INBOX_SCHEMA_ONLY_NO_PUBLICATION`, `VNS_P2_0065_EXPECTED_MAIN_SHA=SHA`, `VNS_P2_0065_RECOVERY_VERIFIED=OPERATOR_VERIFIED_RESTORABLE_BACKUP_AND_ROLLBACK`. Before the only SQL write it rechecks exact current checkout, running service exclusion, schema ledger, permissions, and snapshot. The single migration is sent once in one PostgreSQL transaction. Never auto-retry after an ambiguous write.
- Reports only PASS/REFUSED and metadata counts or an internally calculated digest; never raw source URLs, headlines, sessions, signed source material, or credentials.

## Hard blockers

If the live ledger has **0063 but not 0064**, installing 0065 is **not allowed**. First inspect the separately authorized P3 asset provenance installation pathway. If ledger is incomplete, out of order, any forbidden feed service is running, rights differ, or current `main` advanced after checkout, stop. `--status` may confirm already installed 0065; `--apply` cannot run twice.

An in-transaction migration can still acquire DDL locks; **do not execute `--apply`** until the operator has separately approved the backup, maintenance window, exact target images, scope, rollback and possible API sessions. CI tests mock all DB/Docker/Git access.

The production feed's current rights, signed allowlist, privacy and ACLs must be independently verified. The schema does **not** authorize a live feed or any newsroom publication.
