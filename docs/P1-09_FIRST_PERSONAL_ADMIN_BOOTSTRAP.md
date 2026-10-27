# First owner/admin bootstrap: P1-09 / #227

This is a **one-time, operator-controlled** bootstrap for the exact confirmed live PostgreSQL state: migration 0018, zero editor accounts, zero registered operators, and no member of either provisioner/governor role.

## Owner-approved policy

The owner accepts no VideoNews backups and loss of bootstrap credentials on VPS loss. Only the existing VideoNews PostgreSQL container is modified. No paid AI calls, API/Web restart, provider key installation, external service, queue change, or backup is performed.

## How attribution works

The helper provisions two **distinct, privately credentialed PostgreSQL LOGIN roles**:

- \`vns_owner_governance_login\` may SET ROLE \`vns_operator_governor\` and register the provisioner. The registry audit event's \`authorized_by\` comes from its SCRAM-authenticated PostgreSQL \`session_user\`.
- \`vns_owner_provision_login\` may SET ROLE \`vns_editor_provisioner\` and create/activate exactly the first \`vns_owner_admin\` account, triggering two account lifecycle audit events. The audit's \`operator_login\` is the authenticated \`session_user\`, not a forged request field.

Both logins belong to the same actual project owner, **not** two independent human reviewers. PostgreSQL role names are fixed service identifiers; keep all secrets private to that owner. Both logins have no superuser, CREATEROLE or CREATEDB powers, and the API is not made a member.

The owner admin receives a unique local random password, stored in the git-ignored directory \`secrets/p1-owner-bootstrap\` (0700; secret files 0600). Passwords are not printed in terminals, chat, code, logs or GitHub. The program sends SCRAM verifiers to the database, never password plaintext. Authenticated actor connections use TCP on the Docker bridge with a server-side SCRAM rule; **no Unix-socket trust or SET SESSION AUTHORIZATION impersonation** is used. Key and password data may still be lost permanently without a backup.

## Preconditions and commands

First, the code and CI from this PR must be merged, the operator checkout must be clean \`main\` and its exact commit reviewed, and no other schema/operator maintenance may be occurring. The database must remain at migration 0018 with zero accounts, operators and owner login roles.

Read-only preflight (no secrets generated):

    python3 scripts/p1_09_first_personal_admin.py --preflight

After explicit acceptance of the no-backup risk, the **actual database-changing operation** is:

    VNS_P1_NO_BACKUP_RISK_ACCEPTED=I_ACCEPT_UNRECOVERABLE_LOSS \
      python3 scripts/p1_09_first_personal_admin.py --apply

Do not rerun after any failure. On interruption the role transaction may already have committed, or registration may have succeeded without account activation. Inspect read-only database roles, account and audit counts before deciding on any repair. **Never drop roles or reset the database as a recovery shortcut.**

## After success

Expected operator-facing output (no secrets): one active named admin, one active registered operator, two nonprivileged owner logins, and correctly attributable registry/lifecycle audit entries.

The owner's browser login password is in the private file \`secrets/p1-owner-bootstrap/owner_admin_password\`; access it locally only when secure editor login has been deployed. Do not paste any contents here. The provisioner and governor login passwords should not be mounted in Web/API containers.

**Not accomplished here:** no named provider-DB writer login, no master encryption key file, no new pinned API/Web images, no active write feature gate, no browser-to-PostgreSQL acceptance; #227 remains open. Separately #230 still needs real response usage and budget enforcement before the capped 1 € provider canary.
