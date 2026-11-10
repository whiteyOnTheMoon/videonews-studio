# P3-01 / 0064 – operator-only asset provenance migration gate

This is **GitHub-only preparation**, not a live VPS action. Migration 0064 creates provenance columns and rights constraints on assets, a scoped asset usage catalog, triggers and a view whose render_allowed is **always false**. Existing private MP4 files remain untouched, and historical "cleared" assets are **not** grandfathered into any new render privilege.

## Verified current operator findings

- PostgreSQL 0063 present; 0064 absent; 0065 absent; asset rights view absent.
- 3 source registry approvals and valid host grants, 0 publisher metadata reviews, 19 historical candidates from 2 sources.
- Web and API running on pinned protected private-gallery digests, worker running; no separate live feed consumer/producer.
- Root filesystem ~15.8 GiB free. Do not build on VPS.

## Read-only modes

- `python3 scripts/p3_01_schema_0063_to_0064.py --status --expected-sha SHA`: reads exact clean personally owned main release SHA equal to remote main, existing healthy PostgreSQL, ordered 65-file migration inventory, schema ledger and role-specific permissions. Reports only whether schema 0063 or 0064.
- `--preflight`: **read-only** and requires schema exactly at 0063. Verifies exact source DDL from Git, required assets/videos/scripts and 0063 inbox, no partial 0064 objects/columns, no publication rows, and private hash of unchanged aggregate rows. It does not stop, rebuild or restart containers.
- `--apply`: **not authorized by this PR**. Apart from successful preflight it requires a separately approved VPS maintenance window, actually tested restorable backup, API and normal worker already **stopped** by an independently approved operation (the gate never stops them), and all three exact acknowledgments:
  - `VNS_P3_0064_SCHEMA_OPERATOR_APPROVED=INSTALL_ASSET_PROVENANCE_SCHEMA_ONLY_NO_RENDER_OR_PUBLICATION`
  - `VNS_P3_0064_EXPECTED_MAIN_SHA=SHA`
  - `VNS_P3_0064_RECOVERY_VERIFIED=OPERATOR_VERIFIED_RESTORABLE_BACKUP_AND_ROLLBACK`
  It then rechecks main SHA, SQL privileges, status, recovery admission, running services and a private count digest. The tracked original migration is executed **at most once** in its PostgreSQL transaction. If any write's outcome is ambiguous, manually inspect the ledger; never retry blindly.
- `--status` after schema 0064 verifies columns, seven rights constraints including NOT VALID historic clearance rule, both triggers/functions, isolated asset_uses table, zero render_allowed rows and untouched 0063 reader.

## Rollout risks and rollback

Migration 0064 adds DDL to vns.assets; existing rows survive but later UPDATE of historical "cleared" rows lacking provenance may be rejected. Confirm actual asset states and active editor/worker workflows before approval. Without a planned maintenance window and backup/restore evidence, **do not apply**.

The 0064 down migration rejects rollback after any new provenance or usage data exists. Never use it automatically. Reverting only new images will not roll back schema, and private gallery access must remain protected. Scope excludes Redis, live feeds, cloud access settings, rendering, publication and media directories.

After separately approved and verified schema 0064 rollout, use the independent 0065 status/preflight gate and a second explicit 0065 deployment approval. Both migration gates must be checked against actual clean main at that moment. Do not run either gate against the current older VPS checkout without first planning an approved, non-disruptive code synchronization.
