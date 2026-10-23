# P1-05 – PostgreSQL editorial model

Status: draft PR only. The already running internal Web and API containers on the VPS are unchanged. No database container or migrations have been run on the VPS.

## Scope

Migration 0001 creates the separate PostgreSQL namespace vns, a migration ledger and eleven model tables:

| Table     | Purpose                                                   |
| --------- | --------------------------------------------------------- |
| sources   | Source name, canonical URL, editorial trust               |
| stories   | Topics with review status and original source             |
| claims    | Verifiable assertions with evidence links and review time |
| licenses  | Descriptions and references for license terms             |
| assets    | Media metadata with explicit rights-review status         |
| scripts   | Versioned editorial manuscripts                           |
| jobs      | Job status, retries and idempotency keys (no worker yet)  |
| videos    | Video records linked to a script and optional render job  |
| costs     | Nonnegative provider cost records                         |
| approvals | Human review history for videos                           |
| uploads   | External platform publication status and IDs              |

The tables use generated UUIDs, created_at and database-managed updated_at timestamps, explicit statuses, unique constraints and foreign keys with RESTRICT. Claims require a verification date to be marked verified. Asset rights clearance requires both a license and a verification date. Published-upload records require an external identifier and completion date.

Important: A license reference does not alone prove lawful rights; a database approval row does not enforce a publishing gate. These protections need subsequent server-side validation, authentication (P1-06), job handling (P1-07) and human review. No uploads, render jobs, API routes, authentication or media acquisition are implemented in this slice.

## Migration safety

The up and down SQL migrations are transactional and intentionally fail when already applied or reversed. The down migration is DESTRUCTIVE: it deletes every row and table in the vns schema. It intentionally avoids CASCADE to fail closed on unknown external dependencies. No startup migration runner is installed.

The VPS has no offsite backups. NEVER run the migration or its reversal on the VPS without a separate authorization covering a persistent database, backup/restore plan and rollback.

## CI testing

The PR-only GitHub Actions workflow creates a disposable PostgreSQL 17 container on a GitHub-hosted runner, with no network, no published ports and an ephemeral memory-backed data directory. It executes up, test inserts and constraints, down, checks for cleanup, then repeats the entire cycle. Test insertions are rolled back. The shell script refuses to run outside GitHub Actions. CI uses a dummy password and no production credentials or external paid database.

CI runtime uses Free-plan included minutes with the existing account 0-dollar spending protections; no paid plan or services are authorized. Passing CI is not approval for VPS database activation, merge or public deployment.

Merge governance: independent review is required unless the operator explicitly authorizes a new one-time exception for this specific PR. No previous review exception carries over.
