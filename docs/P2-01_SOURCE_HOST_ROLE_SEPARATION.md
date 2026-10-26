# P2-01 — Source/host cross-role denial in disposable PostgreSQL

This offline regression test confirms that the non-login source-admin writer cannot call the host-approval mutation function and the non-login host-approval writer cannot call the source-registry mutation function. It also checks direct read permissions, API runtime restrictions, and membership inheritance between those roles. The checks run in both disposable migration cycles.

This is **not** a named LOGIN connection or a proof of independent human approval. The PostgreSQL functions accept caller-supplied editor UUID and auth version; those parameters must be bound to a strongly authenticated, authorized and distinct principal before production use. Separate, constrained LOGIN sessions, revocation behavior, dual control and immutable audit acceptance remain mandatory. No VPS changes, active database roles, keys or actual source requests are performed. Keep #16 open.
