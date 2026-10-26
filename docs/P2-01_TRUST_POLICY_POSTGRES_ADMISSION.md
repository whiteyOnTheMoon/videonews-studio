# P2-01 — Dormant PostgreSQL trust-policy anchor

A separate server-enforced function `vns_source_anchor.advance_trust_policy` protects an operator-pinned Ed25519 trust-policy revision and SHA-256 digest. The worker adapter calls only the function and strictly verifies the boolean response. The authority table has no runtime DML grant or implicit bootstrap. The independent operator must separately provision a non-login owner and an EXECUTE-only LOGIN identity with a trusted TLS connection.

The DDL lives outside ordinary migrations and is exercised only in disposable GitHub CI. SQL rejects older revisions and same-revision digest substitutions; concurrent requests serialize at the row. A same-host database, shared storage snapshot or common administrator remains an unsafe trust domain. No key material, network connection, PostgreSQL LOGIN, deployment, source polling, or scheduler activation is included.

Before live use: independent key review, external authority and bootstrap, immutable audit trail, restore and credential revocation tests, independent trust-policy distribution, end-to-end verification with the signed source export, and operator approval. Issue #16 remains open.
