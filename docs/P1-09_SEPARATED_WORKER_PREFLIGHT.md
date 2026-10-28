# P1-09: separated worker database admission and read-only preflight

This is an **offline-safe integration step**, not a live AI worker release.

PR #315 added a one-use encrypted credential envelope reader. The new
`provider-worker-db-admission.ts` refuses to compose the SQL budget
writer with that credential reader unless each connection is authenticated
under its own dedicated PostgreSQL LOGIN with exclusive membership.

The expected operational identities are:

- `vns_provider_usage_login` inheriting only
  `vns_provider_usage_writer`
- `vns_provider_secret_login` inheriting only
  `vns_provider_secret_reader`

These fixed role identifiers are infrastructure contracts, not provider
model names, prices, API keys, approval flags or customer settings.
**Neither LOGIN is created by this PR.** The existing NOLOGIN roles
remain unchanged. Credentials are never generated, seeded or logged.

## Fail-closed checks

Both connections must attest exact `session_user` and `current_user`,
membership in only the corresponding NOLOGIN role, ability to invoke
only the relevant SQL function and denial of the opposite one.
Direct ciphertext-table reads or writes, budget-policy writes,
administrator price mutations and PostgreSQL superuser/role-creation/
database-creation/replication/RLS-bypass privileges must all be absent.
Neither the API provider administrator login nor the broad database
owner is acceptable as either principal.

The optional one-shot program
`apps/worker/dist/provider-worker-preflight-once.js --read-only`
reads exactly two private password files, requires both explicit
environment acknowledgements, and connects with PostgreSQL's
`default_transaction_read_only=on` mode. It issues only SELECT
against catalog role metadata and privilege checks. It does **not**
fetch the encrypted key, open the master-key directory, reserve a
budget, claim a dispatch, read a job, subscribe to a queue or contact a
provider. Any mismatch exits nonzero and prints a generic error.

An additional default-disabled, non-entrypoint
`dormantSeparatedProviderWorker` composes the existing budget bridge,
claim-bound secret scope and explicitly injected transport only after
both roles pass their SQL checks. It cannot be activated by Compose
or a background worker. The existing runtime `index.ts` is unchanged.

## Optional Compose overlay

`deploy/compose.provider-worker-preflight.yaml` requires the explicit
`provider-preflight` profile. Both enable and operator-ack flags
default to false. It uses a disposable read-only worker image, no
ports, no external network, limited memory and CPU, and two separate
read-only host file mounts with `create_host_path: false`.

The source file paths must be privately provisioned for the container's
UID and exported as
`VNS_P1_PROVIDER_USAGE_PASSWORD_HOST_FILE` and
`VNS_P1_PROVIDER_SECRET_PASSWORD_HOST_FILE`.
The overlay expressly sets live-dispatch/canary flags to false and
does **not** mount the provider master key or Admin DB password.
Never run the overlay in the ordinary production Compose invocation.

**Do not run this on the current VPS.** The last verified VPS schema
was 0018, whereas the read-only checks depend on schema through
migration 0043 and on two unprovisioned distinct PostgreSQL logins.
A separate, owner-approved schema/role/password preflight and
controlled rollout are prerequisites.

## Remaining blockers

A successful read-only preflight proves neither actual vendor
capabilities nor price accuracy. It does not validate the real
credential-unsealing process, network egress, tokenizer input bounds,
provider billing, EUR exposure under real exchange movement, or
operator-authorized scheduling. A network-capable production worker
entrypoint, distinct runtime secret mounts and a reviewed paid canary
remain intentionally absent.

The user-confirmed IONOS backups and Beszel monitoring are left alone.
No SQL migrations, API calls, key provisioning, Redis queues, Docker
restarts, VPS modifications or costs are triggered by this package.

## Validation

Unit tests check missing flags, strict two-file identity admission,
absent or leaked privileges, superuser status, cross-role membership,
authentication errors, distinct connections, read-only enforcement,
closure on failures and no possible send before attestation. The
normal monorepo, Docker and worker CI must pass before merge.
