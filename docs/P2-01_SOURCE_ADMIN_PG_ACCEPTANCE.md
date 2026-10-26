# P2-01 – Source PostgreSQL acceptance

PR #238 added the dormant source registry schema and adapter. Its generic migration workflows **did not execute migration 0020**, despite reporting green. This follow-up closes that test coverage gap without activating any runtime.

The disposable GitHub Actions migration script now applies migration 0020, tests NOLOGIN/role ACLs, named-admin version and active checks, direct-write denial, one successful CAS+audit event, stale revision rejection, append-only audit protection, and revoked admin denial. It then runs **two real independent PostgreSQL sessions** racing for revision zero. Exactly one revision and one attributed audit row must remain. Finally, migration 0020 rolls back as part of two complete apply/test/down cycles. No actual administrators, keys, sources or external requests are used.

This is not an approval for live sources. Additional production gates: independent narrowly scoped DB LOGIN, authenticated BFF wiring and personal session tests, feed registry export and allowlist integration, operator-approved source rights, live database restore, and controlled scheduler acceptance in #17.

Note: the SQL function receives a validated snapshot from the dormant server contract. The database does not itself validate every URL and license field nor independently prove that action labels match source transitions; before granting a production LOGIN, this boundary requires further DB-side mutation narrowing or an equivalent trusted-only callable interface.
