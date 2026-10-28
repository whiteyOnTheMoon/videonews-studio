# P1-09: Dormant One-Shot Native Text Transport

This package adds fixed-origin HTTPS request serializers for the official
OpenAI Responses API and Gemini `generateContent` API. Both are isolated
from the running worker's entrypoints. **No new startup flag, paid call,
secret reader, vendor credential or VPS deployment is provided.**

## Order of operations

The separate, default-disabled coordinator enforces:

1. Strict model ID, prompt byte and output limit validation without SQL
2. Existing PostgreSQL USD/EUR reservation under configured budgets
3. Immutable SQL price/reservation projection before any vendor operation
4. **Irreversible one-shot SQL dispatch claim** before credential access
5. Separately supplied scoped provider-key callback
6. Exactly one fixed-host HTTPS request without retry or redirect
7. Validate native completed, text-only response and vendor usage evidence
8. Quote against the SQL price snapshot; atomically persist usage receipt
   and settlement or halt the global budget for operator review

A failed or uncertain network response must not be retried. The SQL
claim is persistent and cannot be reset by a worker restart. A failed
halt is never treated as successful recovery.

## Hardcoded network destinations (not provider configuration)

OpenAI: `https://api.openai.com/v1/responses`.

Google: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`.

The only dynamic path component is a strictly validated model identifier.
Credentials are carried as a Bearer header or the `x-goog-api-key`
header respectively, never in a query string or URL. The request fixes
`POST`, `redirect: error`, `cache: no-store`, a 10-second abort
limit, no streaming, no tools and a capped JSON response size. OpenAI
sets `store: false`. Native response validation rejects tools,
non-text content, incomplete operations, mismatched models and
malformed accounting.

The provider hosts are protocol constants needed to block arbitrary
user-supplied destinations. Provider and model **selection** remains
admin-managed and SQL-reviewed, not hardcoded. No vendor model IDs or
prices are bundled or enabled here.

## Limits and no-go-live

This package does not implement an authorized **credential reader** that
unseals the Admin-managed key in a trusted worker scope. It does not
provide an independently verified provider pricing source or signed
vendor billing attestation. The request byte bound is conservative but
**does not guarantee a provider-specific input-token count**; live
requests require independently verified tokenizer/context guarantees
or a hard provider-side input cap. A provider's response may still
change in a way that requires a new billable-unit contract.

There is no way to enable the coordinator from a running worker or
Admin tool. An explicit independent production review must integrate
secrets, vendor response provenance, private network egress, SQL
permissions, confirmed EUR cap, response metering and operator audit.
Do not interpret a green isolated test as permission to send a live
request. A separately approved <=1 EUR canary is still necessary.

The existing user-confirmed IONOS backups and Beszel monitoring are
not changed by this package. No VPS migrations, keys or billable
requests are performed.

## Tests

Worker tests use only injected fake fetchers, synthetic credentials
and in-memory SQL bridges. They require no network. Checks cover the
default-off factory, fixed HTTPS destinations, exact payload schemas,
request limits, no key or SQL access prior to claim, no retries,
redirection rejection, content type/size limits, malformed vendor
usage, non-text outputs, and irreversible halts after unknown outcome.

References for the request contract:

- https://developers.openai.com/api/reference/cli/resources/responses/methods/create
- https://ai.google.dev/api/generate-content
