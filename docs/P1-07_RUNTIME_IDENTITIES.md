# P1-07: future runtime PostgreSQL identity binding

The 0012 migration defines three NOLOGIN permission groups. These **cannot authenticate** and are not used by the running components. The new identity mapping in `apps/worker/src/runtime-db.ts` reserves distinct service login names and requires explicit approval when selected; it does not provision users or secrets.

**Not implemented:** PostgreSQL LOGIN provisioning, independent credentials, role membership, TLS / pg_hba review, integration of each service connection, and operator rollout. Current dispatcher and status CLI code still use `vns` and therefore must remain disabled.

Do not create or enable live editorial runtime services based on this change. The probe-only worker remains untouched. Before actual activation, use CI-only service logins to exercise real SQL under each identity, verify denials, and approve secure operator secret generation and rollback separately.
