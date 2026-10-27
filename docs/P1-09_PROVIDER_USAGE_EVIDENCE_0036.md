# P1-09 / #230: dormant provider-usage evidence ledger

This package separates **provider-reported token measurements** from
\`vns.job_token_usage\` and \`vns.synthetic_ai_reservations\`, which remain synthetic.
It is **not** a money movement ledger, invoice, or permission to invoke an
external provider.

## New schema (0036)

\`vns.provider_usage_receipts\` is append-only, with an immutable response ID,
request ID, job ID, provider, model, token breakdown, price-version identifier,
calculated USD micro-cost and recording timestamp. A reported price version
is only an identifier; **it is not an independent validation of provider price**.
Only a trusted, separately approved adapter may derive these fields from
provider responses and approved pricing. No prompt text or API credentials
are stored.

A PostgreSQL definer function \`record_provider_usage_evidence\`:
- rejects unknown provider names, invalid IDs, token/cached-token contradictions,
  unknown cost and negative amounts;
- uniquely binds a job/provider/request and a provider/response identifier;
- returns the exact same receipt ID on byte-equivalent idempotent retry;
- rejects conflicting payloads and reuse of response IDs across jobs;
- executes with a dedicated NOLOGIN executor. The caller role is also NOLOGIN
  and has **zero role members** and no direct table privileges after migration.

There is no productive role/login, network client, secret or runtime route
mount. A small worker SQL adapter is opt-in, fail-closed and unimported by the
running worker. It returns \`persistent: true\` only after the database confirms
a receipt, but always returns \`approvedForPayment: false\`,
\`reconciled: false\`.

## Tests

Disposable PostgreSQL CI applies and reverts migration 0036 twice (through
\`db/scripts/test_migrations.sh\`). SQL tests reject replay mismatches,
cross-job reuse, malformed values, unauthorized table writes, and mutation of
append-only history. Worker unit tests check the opt-in gate, exact parameter
binding and secret-free error messages.

## Not implemented

A complete #230 release requires explicit provider-native response adapters
(OpenAI and Gemini, including text, cached tokens and audio/TTS units);
versioned trusted pricing with time ranges; a durable **pre-spend** reservation
and cancellation system linked atomically to receipts; per-job/day/month
budgets; unknown/partial usage handling; network deny behavior; a 1 EUR
aggregate test authorization that accounts for the actual billing currency;
and an operator-approved limited provider canary with genuine credentials.

Do not run \`0036\` on the VPS independently while the deployed ledger is still
\`0018\`. Migrations \`0019\` through \`0035\` are separate Phase-2 components
and need their own checked rollout plan. Do not run \`db/scripts/test_migrations.sh\`
on the live VPS (it is destructive CI-only). The operator deliberately chose
not to make backups; no change here weakens that decision or implies recovery
readiness.
