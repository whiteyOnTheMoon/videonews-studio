# P1-07: isolated PostgreSQL runtime identities

The migration 0012 defines three dormant NOLOGIN permission groups. The dispatcher and status reconciler now require a separate, explicitly enabled PostgreSQL login identity before making a database connection. No fallback to the owner account `vns` is permitted.

The dispatcher requires `VNS_PG_RUNTIME_IDENTITIES_ENABLED=true` with `VNS_POSTGRES_RUNTIME_PASSWORD_FILE=/run/secrets/pg_outbox_dispatch_password`; the status reconciler requires the same enable flag with `/run/secrets/pg_job_status_sync_password`. The future research writer's reserved secret path is `/run/secrets/pg_research_writer_password`. All three passwords must be provided through independently mounted Docker secrets. No passwords are committed.

**Still blocked:** Dedicated LOGIN roles, membership to the corresponding NOLOGIN groups, independent credentials, Compose secret mounts, PostgreSQL authentication policy review and operator acceptance are not implemented. The research processor also has no production CLI wiring. The separate dispatcher/status entrypoints remain disabled on the VPS and cannot start successfully without this missing provisioning.

No VPS deployment is authorized by this code change. The existing probe-only worker remains untouched. Require disposable CI authentication and permission-denial tests using actual distinct login users before any live rollout.

## Disposable login acceptance

The worker CI harness now provisions three distinct LOGIN fixtures in an ephemeral PostgreSQL 17 container, maps each fixture to its scoped NOLOGIN grant group, authenticates over TCP with its own fixture password, verifies the authenticated SQL identity, and refuses cross-component access. These fixed fixture passwords are never production credentials. The harness does not modify the VPS database or create operational logins. Production account provisioning, independent Docker secrets, login authentication review, controlled migration and operator acceptance remain blocked.

## Controlled operator rollout — not yet authorized

1. Obtain an independent, read-only VPS inventory: active container IDs, current database roles, applied migration count, Docker secret mounts, memory/disk and existing recovery evidence. In particular, do not infer migration 0012 was applied from a Git merge.
2. Prepare three different high-entropy passwords locally in separate untracked files with restrictive owner-only permissions. Never display, paste into chat, commit, pass as CLI arguments or place plaintext in logs. Verify that each container user can read **only its own** file.
3. Provision the dedicated LOGIN roles through a reviewed, narrowly scoped administrative SQL transaction. Grant exactly one corresponding NOLOGIN group to each login and no ownership, superuser, CREATE, replication or cross-service memberships. Require SCRAM authentication, verify the authentication policy and rollback strategy before writing to the VPS.
4. Authenticate separately as all three identities from their intended network and verify PostgreSQL `current_user`, allowed statements, denied cross-service DML/DDL, and negative wrong-password/cross-password attempts. Record redacted receipts only.
5. Add a separately disabled Compose overlay with individual secret mounts and explicit service flags; validate the rendered Compose configuration without starting containers. Do not replace the existing probe worker or change Web, API, Cloudflare or other projects.
6. Only after an explicit bounded operator approval, enable one component at a time with read-only receipts, error budgets, rollback and no external source, rendering or publishing side effects.

Stop if the operator login cannot be authenticated independently, if any denied query succeeds, if an unapproved service would be recreated, or if credentials would appear in a terminal transcript. The experimental no-backup exception does not establish disaster-recovery acceptance.

### CI coverage

Disposable PostgreSQL tests authenticate all three service LOGIN identities and reject cross-service writes. They also reject the use of one service's password to authenticate to another and deny schema creation. These checks do not prove VPS credential installation or safe live rollout.
