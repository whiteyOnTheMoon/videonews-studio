# P1-07: isolated PostgreSQL runtime identities

The migration 0012 defines three dormant NOLOGIN permission groups. The dispatcher and status reconciler now require a separate, explicitly enabled PostgreSQL login identity before making a database connection. No fallback to the owner account `vns` is permitted.

The dispatcher requires `VNS_PG_RUNTIME_IDENTITIES_ENABLED=true` with `VNS_POSTGRES_RUNTIME_PASSWORD_FILE=/run/secrets/pg_outbox_dispatch_password`; the status reconciler requires the same enable flag with `/run/secrets/pg_job_status_sync_password`. The future research writer's reserved secret path is `/run/secrets/pg_research_writer_password`. All three passwords must be provided through independently mounted Docker secrets. No passwords are committed.

**Still blocked:** Dedicated LOGIN roles, membership to the corresponding NOLOGIN groups, independent credentials, Compose secret mounts, PostgreSQL authentication policy review and operator acceptance are not implemented. The research processor also has no production CLI wiring. The separate dispatcher/status entrypoints remain disabled on the VPS and cannot start successfully without this missing provisioning.

No VPS deployment is authorized by this code change. The existing probe-only worker remains untouched. Require disposable CI authentication and permission-denial tests using actual distinct login users before any live rollout.

## Disposable login acceptance

The worker CI harness now provisions three distinct LOGIN fixtures in an ephemeral PostgreSQL 17 container, maps each fixture to its scoped NOLOGIN grant group, authenticates over TCP with its own fixture password, verifies the authenticated SQL identity, and refuses cross-component access. These fixed fixture passwords are never production credentials. The harness does not modify the VPS database or create operational logins. Production account provisioning, independent Docker secrets, login authentication review, controlled migration and operator acceptance remain blocked.
