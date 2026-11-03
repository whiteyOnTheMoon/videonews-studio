# P2-01 — Independent-authority operator read-only attestation

**Scope:** Post-bootstrap evidence for an **externally administered**
PostgreSQL authority, not a way to provision one. No application database,
Kurvenfunk database, or second container on the same VPS qualifies as an
independent anti-rollback authority merely because it is distinct.

The source/host revisions, complete signed-envelope SHA-256, and the
signing-policy revision/digest must first be obtained from the previously
reviewed root-only bootstrap candidate report. The independent operator must
have separately approved their provenance, source rights, and signer custody.

## Operator-side PostgreSQL check

The SQL file at
db/independent-anchor/operator_readonly_attestation.sql runs exclusively in
an already authenticated **operator/DBA psql session on the separate
authority**. It requires explicit psql variables for the database, runtime
LOGIN, two source revisions, signed envelope SHA-256 and exact signing-policy
revision/digest. In particular, it **does not** log in as the worker or grant
the worker privileges.

Example invocation on that separate authority, after independent review and
bootstrapping, with an existing operator-authenticated psql connection:

    psql -X -v ON_ERROR_STOP=1 \
      -v expected_database=vns_source_anchor \
      -v expected_runtime_login=YOUR_PREAPPROVED_RUNTIME_LOGIN \
      -v expected_source_revision=8 \
      -v expected_host_revision=7 \
      -v expected_envelope_sha256=YOUR_REVIEWED_SIGNED_ENVELOPE_SHA256 \
      -v expected_policy_revision=1 \
      -v expected_policy_sha256=YOUR_REVIEWED_TRUST_POLICY_SHA256 \
      -f db/independent-anchor/operator_readonly_attestation.sql

The SQL checks exact high-water rows, preapproved policy digest, PostgreSQL 17,
the expected database and minimal runtime grants. It refuses direct access
to all three authority tables, membership in their owners, privileged
runtime role attributes, login-enabled authority owners and functions
without SECURITY DEFINER with a fixed pg_catalog search path.

It uses BEGIN TRANSACTION READ ONLY, ROLLBACK, and a boolean result captured
by the psql client. PASS/REFUSED are generic; sensitive database content
is not printed. An absent relation, malformed/missing input or mismatched
digest fails closed. Re-running it makes no changes to high-water state.

## Separate requirements not proven by this check

- A distinct server/administrator and recovery/rollback domain. Server
  identity must be independently established, **not inferred** from a
  passed SQL query or from a second database on the same VPS.
- An actual worker PostgreSQL TLS connection using a pinned CA and hostname
  verification, its named password-authenticated LOGIN, and independent
  monitoring of disconnect, revocation, restore and replay outcomes.
- Review of the implementation of the two SECURITY DEFINER functions,
  owner role custody and out-of-band signing key policy approvals.
- Current rights for each of the 3–5 approved news sources, rate limits,
  operational canary, and the separate approval for the first checkpoint
  and live feed. None is automatically authorized by this query.

The command is **not for the Ubuntu shell** except as a complete
psql invocation on a verified independent authority. It must never be
run against the existing VideoNews Studio or Kurvenfunk databases.

## CI

The existing independent PostgreSQL-17 workflow now also executes this
read-only operator report against a disposable, purely synthetic authority.
It verifies a matching candidate passes, while wrong envelope hashes,
wrong runtime LOGIN, direct high-water UPDATE grants, and authority-owner
role membership fail. The CI authority cannot prove physical separation,
a production TLS certificate or real source rights.

Existing IONOS backups and Beszel monitoring remain untouched.
