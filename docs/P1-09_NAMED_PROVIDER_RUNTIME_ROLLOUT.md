# P1-09 / #227 – Named provider configuration: live wiring

This package connects the existing named-editor audited provider configuration through the Web BFF, API entrypoint and PostgreSQL adapter. **All gates default to OFF.** It does not send requests to OpenAI/Gemini or activate provider execution.

## Complete request path

Browser editor (OpenAI/Gemini) → POST /api/admin/ai-providers (separately gated Next.js BFF, origin + personal admin session validation, strict body framing) → internal POST /admin/ai-providers (personal admin identity rechecked) → global PostgreSQL mutation slot (max 5/60 s) → AES-GCM envelope from private 32-byte file → dedicated `vns_provider_config_login` pool → atomic `admin_mutate_ai_provider_as_editor` SQL and personal audit. GET always returns public metadata only, with `active:false`. Existing editor-account revocation remains enforced by PostgreSQL; no shared admin cookie authorizes a provider write.

The API reads the encryption master key afresh within each HTTP operation and clears its in-memory buffer after the operation. The key stays outside Git, PostgreSQL, JSON and process environment. The service runs as Unix UID 1000 (`node`), and the private directory and key file must belong to that UID with modes 0700 and 0600, respectively; permission mismatches refuse startup. The private key is intentionally not backed up under the operator's current policy; if lost, existing encrypted provider credentials must be removed and re-entered. Do not rotate an encryption key without a separately reviewed re-encryption plan.

## Optional rollout overlay

`deploy/compose.provider-admin.yaml` is *never part of the routine stack*. It requires the existing, operator-verified compose files and an explicitly chosen rollout, plus:

1. A separate PostgreSQL LOGIN named `vns_provider_config_login`, with an independently provisioned strong password, only membership in the existing `vns_provider_config_writer` role, **no direct table grants**, no superuser/CREATEROLE/CREATEDB and role verification after configuration. The existing writer/executor remain NOLOGIN. Do not use the database superuser or reuse the admin password for this login.
2. Private, untracked files `./secrets/pg_provider_admin_password` and `./secrets/vns/provider-master-key`; the latter is exactly 32 binary bytes, and is never printed, emailed, logged or committed. The containing directory must also be private and owned by the container UID. If files do not match the required permissions, startup must fail rather than relaxing checks.
3. Existing personal editor-admin account registered and active, with `VNS_EDITOR_AUTH_ENABLED` and associated separately gated admin-data services. The user signs in with the personal editor session, not just the legacy shared-admin cookie.
4. Explicit approved API/Web image digests matching the reviewed Git commit; Compose is invoked with the actual existing files, plus this overlay **last**. Only the Web and API services should be updated after immutable image/health preflight.
5. An operator-run read-only schema/ACL audit, CSRF/revocation/forged cookie negative tests, a synthetic key write/replace/remove test (real key **not** yet entered), and an incident/rollback record.

## Forbidden claims / follow-up gates

This PR alone does not provision the LOGIN or master key on the VPS, does not deploy new images, does not prove an end-to-end live browser test, and must not close #227. The separate #230 budget/cost pipeline remains incomplete; **the authorized maximum 1 EUR test is not a spending instruction** until hard budget checks and a separate canary approval. Baseline monitoring stays Beszel; no backup service, upgrade, extra paid service or secret export is introduced.

The model allowlists are deliberately still conservative existing offline contracts. Changing providers/models/voices to dynamic reviewed choices is separate from mounting the secure write path; do not claim arbitrary models can be selected yet.
