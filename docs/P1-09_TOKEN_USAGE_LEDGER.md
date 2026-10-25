# P1-09 — Synthetic per-job token receipt ledger (Git-only)

Refs #9. **Code/CI only**; no running worker invokes this code. The current
probe worker does not make provider calls. This change does NOT create
actual provider metering, invoice reconciliation, or billing protection.

## Design

`db/migrations/0013_synthetic_token_usage.up.sql` defines a new
`vns.job_token_usage` table with one append-only receipt for every
(`job_id`, `provider`, `request_id`). It does NOT replace the existing
`vns.costs` table or modify its legacy values.

Each receipt stores a known job UUID, a bounded provider/model/request ID,
explicit input/output token counts, caller-supplied integer prices in
micro-USD per million tokens, and a PostgreSQL GENERATED `estimated_cost_micro_usd`.
Numeric multiplication and rounding are computed using PostgreSQL `numeric`,
not floating-point dollars. A matched retry returns the original receipt
UUID; a retry with a different model, tokens or price raises an error.

Critically, the `source_type` column is constrained to `synthetic` only.
Provider-reported usage cannot be mislabeled as approved actual charges.
Proposed real use requires another reviewed migration and data provenance
policy (provider request ID, token interpretation, price currency/version
and billing reconciliation). A new `vns.record_synthetic_token_usage(...)`
function is SECURITY INVOKER and explicitly denied to PUBLIC. No new
LOGIN/role membership is created and existing API, dispatcher, research
and audit roles receive **no permission** to read or insert this ledger.
An ordinary application connection cannot use it.

Database triggers reject row updates/deletions and full-table TRUNCATE.
Like other trigger-protected PostgreSQL objects this does not protect
against a superuser changing the schema or disabling triggers. Offsite
backups and restore evidence remain separate mandatory safeguards.

## Worker boundary

`apps/worker/src/token-usage.ts` contains a dormant dependency-injected
adapter that must be explicitly constructed with `enabled=true` and a
separately supplied PostgreSQL Pool. No service imports/starts this adapter.
Inputs must have exactly the eight approved fields; unknown attributes
including API keys, prompts or source documents are rejected. It calls
only the parameterized, synthetic-only database function and can retrieve
per-job totals as decimal strings. SQL exceptions are deliberately
sanitized; neither user content nor credentials are returned in errors.

`estimateMicroUsd()` uses integer `BigInt` arithmetic consistent with
the existing Python offline cost model. Reports always say
`estimated=true` and `currency=USD`, never `billed` or `actual`.
An operator dashboard or external API endpoint is not added.

## Verification

- `db/tests/0013_synthetic_token_usage.test.sql` uses disposable jobs,
  verifies idempotency, exact rounding, conflict denial, bad identifiers,
  missing job denial, forced synthetic provenance, append-only triggers
  and SQL least-privilege negative probes.
- `db/scripts/test_migrations.sh` now includes migrations 0012 and 0013
  in both reversible disposable migration cycles.
- The independently bootstrapped PostgreSQL 17 full restore drill now
  includes migrations 0012/0013, source synthetic receipt fixture,
  destination receipt checks, runtime roles, and a dynamic all-table
  fingerprint covering the new table.
- `apps/worker/src/token-usage.test.ts` tests the disabled-by-default
  adapter, strict input payload, integer arithmetic, bound SQL parameters,
  sanitized failures, and per-job summaries without a real database.

All CI jobs use synthetic data; the disposable PostgreSQL test containers
run only in GitHub Actions. Do **not** execute the migration or disposable
test scripts on the VPS. The existing 12 migrations and probe-only
production data stack remain unchanged until a separate explicit operator
approval and rollback plan. There is currently no independent offsite
backup or proven VPS restore; this PR does not waive that risk.

## Still open for full P1-09 acceptance

1. Approve specific provider(s) and price/version sources, including
   explicit per-request spending limits and correct usage/cached-token
   semantics (unknown prices must fail closed).
2. Review/update the ingestion role permissions, provider usage identity
   and authenticated access; test true retries/timeouts and missing receipts.
3. Operate only under a separately approved no-backup experimental
   exception, or adopt independent backup/restore before full production.
4. Compare a sample with provider-issued metering and billing reports;
   estimates alone are not financial ground truth.

VPS host/container monitoring stays with the already installed Beszel.
