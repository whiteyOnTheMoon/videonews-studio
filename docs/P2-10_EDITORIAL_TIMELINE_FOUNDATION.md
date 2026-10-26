# P2-10 — Dormant append-only editorial timeline

Migration 0024 adds an append-only, structured and bounded timeline linked to a story and an existing named editor. It records source, claim, rejected-claim, review, script-version and decision event types with timestamp, optional HTTPS reference and SHA-256 digest. The table denies default runtime writes and refuses UPDATE or DELETE via a database trigger. Synthetic disposable PostgreSQL tests verify immutability and denied runtime write permissions, including rollback cycles.

This is **not** a complete production audit ledger. PostgreSQL superusers/table owners can alter triggers, and no independently protected/WORM audit copy exists. There is no authenticated writer function, no personally scoped grant, no full export endpoint, no versioned signed decision chain and no worker mount. Do not confuse the groundwork with P2-10 acceptance. No VPS migration, live feeds, keys, costs or publication activation.
