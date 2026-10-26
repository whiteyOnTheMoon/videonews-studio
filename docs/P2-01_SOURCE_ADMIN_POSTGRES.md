# P2-01 – Dormant PostgreSQL admin source store (0020)

This increment introduces a **CI-only, unmounted** PostgreSQL adapter for the existing named-admin source administration contract (PR #237). No real publisher, feed URL, key, active schedule, VPS migration or runtime wiring is added.

Migration 0020 creates a singleton versioned snapshot and append-only actor audit. The SECURITY DEFINER entry point locks the active named administrator and matches their auth version; optimistic revision compare-and-swap and the attributed audit insert share one PostgreSQL statement/transaction. The future NOLOGIN writer receives read-only snapshot access and function EXECUTE only. Source payload validation still belongs to the already tested server contract and is repeated in the adapter; the database function is **not** an independent generic mutation API and must never be exposed to untrusted input.

Production gates remain: disposable real PostgreSQL migration, rollback and privilege tests, separate scoped LOGIN, personal-session BFF mounting, controlled source editor mount, export to worker registry/allowlist, and operator-approved source rights and scheduler live acceptance. The source state remains dormant. Do not interpret this migration as a production approval.
