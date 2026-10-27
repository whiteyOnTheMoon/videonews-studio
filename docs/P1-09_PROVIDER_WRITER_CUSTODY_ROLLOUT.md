# P1-09 / #227 — provider writer and encryption-key custody

This package is a **dormant, one-time operator-controlled bootstrap** for the currently confirmed VideoNews VPS state. It never enables OpenAI or Gemini execution, calls providers, creates backups, restarts containers, or changes another project.

## Preconditions

- Existing VideoNews PostgreSQL 17 container healthy, latest applied migration **0018** (exactly 18).
- Exactly one active personally attributed admin and operator, as confirmed by the successful first-owner bootstrap on 27 October 2026.
- No provider DB writer LOGIN, membership or stored provider key already present.
- Operator checkout is clean \`main\`, UID 1000, with enough disk space.
- \`secrets/\` is an operator-owned non-symlink directory with mode 0700.
- The owner explicitly accepts no backups and the possibility of permanently losing any sealed provider credentials if the master key is lost.

## Mechanism and secrets

The guarded helper \`scripts/p1_09_provider_writer_custody.py\` creates:

- PostgreSQL LOGIN \`vns_provider_config_login\`, with no administrative/database/schema privileges and membership **only** in NOLOGIN \`vns_provider_config_writer\`; SCRAM-SHA-256 verifier transmitted to PostgreSQL, never plaintext.
- An independently generated strong password in \`secrets/pg_provider_admin_password\`, operator-owned mode 0600.
- Exactly 32 cryptographically random binary bytes at \`secrets/vns/provider-master-key\`, under private owner UID 1000 directory 0700 and mode-0600 key file. This path matches the existing opt-in Compose overlay and the API key loader.

The helper refuses overwrites and symlinks, validates role membership and performs a real authenticated network login read-only check. If interrupted after file creation or role creation, **do not rerun**. Read-only inspect before repairing; do not drop roles, erase the master key or start another database.

## Operator commands only after this PR passes CI and is merged

Read-only preflight (no files generated):

    python3 scripts/p1_09_provider_writer_custody.py --preflight

The operator's separately authorized, database-changing creation:

    VNS_P1_NO_BACKUP_RISK_ACCEPTED=I_ACCEPT_UNRECOVERABLE_LOSS \
      python3 scripts/p1_09_provider_writer_custody.py --apply

No passwords or encryption keys should ever be pasted into a chat, issue, console transcript or Git. If the key is lost, encrypted API keys must be replaced manually after a separate reviewed key-loss procedure.

## What remains open

This installer establishes only the dedicated provider writer/login and key custody. No fresh API or Web images have yet been deployed, no Next.js write gate enabled, no real admin request or end-to-end auditable provider rotation verified. #227 stays **open** until that acceptance. #230 remains independently blocked on genuine vendor receipts, pricing and atomic budgets; the maximum 1 EUR canary is a cap, not prior authorization to spend without automated enforcement.
