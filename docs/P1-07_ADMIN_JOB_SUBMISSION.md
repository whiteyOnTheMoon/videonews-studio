# P1-07 — Protected internal research job submission

Status: **implemented in Git, disabled by default, not deployed**.

## Flow

1. The browser may POST to `/api/admin/jobs` (Next.js BFF) **only** when
   `VNS_WEB_ADMIN_JOBS_ENABLED=true` and the existing HTTPS Admin BFF
   configuration is valid.
2. The BFF validates an exact `Origin`, exactly one valid
   `__Host-vns_session` cookie, JSON format, a 1024-byte size limit and
   the strictly allowlisted payload shape:
   `{"kind":"research","idempotencyKey":"<24-80 ASCII letters/digits/_/->","topic":"<12-160 characters>"}`.
   It passes only these vetted values to the internal API.
3. The API route `POST /admin/jobs` is independently disabled unless
   `VNS_ADMIN_JOBS_ENABLED=true`, existing AdminAuth is configured and a
   readable `/run/secrets/postgres_password` is present. It independently
   enforces an authenticated 15-minute admin session, exact configured HTTPS
   origin, strict payload validation and bound size.
4. A parameterized PostgreSQL query calls `vns.create_job_with_outbox` to
   persist an idempotent `research` job, its immutable topic and outbox intent
   in one transaction via `vns.create_research_request`. The same idempotency key returns the same job ID.
5. HTTP 202 acknowledges **PostgreSQL persistence only**, not dispatch,
   research execution, video rendering or publication. Error responses never
   expose database connection details.

No dispatcher or worker is activated by this API code. PostgreSQL and Redis
profiles are **not** running on the VPS. Existing P1-06 admin login, public
routing and live Docker containers are unchanged.

## Limitations before enabling on the VPS

- An internal admin dashboard now includes an optional, idempotent "research
  job intent" form and a read-only last-20 job list. They remain disabled
  until the same explicit Next.js API feature flag is enabled, and display
  their disabled state even when the main admin preview is running.
  The form now accepts a validated research topic (12–160 characters).
  Submitting records a topic, but **does not launch automated research**.
- The research worker handler is not implemented. Current workers refuse
  editorial task names. No real research or rendering must be triggered.
- Operator must approve a real PostgreSQL backup destination, restore drill,
  storage budgets, credentials, least-privilege PostgreSQL role (not a
  database superuser), migration execution and a rollback procedure.
- Review admin access, transport origin/CSRF controls, abuse throttling and
  authorized job kinds before any public activation.
- Add completion/status reconciliation between BullMQ and `vns.jobs`.
  At-least-once queue delivery is not a guarantee of exactly-once processing.

CI tests use disposable PostgreSQL, test-only credentials, real API HTTP
sessions and database constraints. CI does not operate on VPS data.

## Dashboard and read-only status endpoint

With the existing authenticated server-rendered `/admin` page, a new
`Rechercheaufträge` section displays a gated form and a clear disabled notice.
Both the form and the API endpoints are disabled by default. When separately
enabled, the browser generates a random idempotency key and its associated topic and keeps both across
network retries until a confirmed PostgreSQL `202 Accepted`. The form says
**vormerken**, never "start research": it stores a database intent only.

`GET /api/admin/jobs` (Next.js BFF) forwards the validated secure admin
session cookie to the independently authenticated `GET /admin/jobs` API.
The API reads the 20 most recent research jobs by created time from
`vns.jobs` joined to `vns.job_outbox`. Only UUID, job kind, topic (or null for older records), persisted
job status, outbox delivery state, and ISO timestamp leave the API.
Idempotency keys, database details and errors are never returned. Neither the
server nor the BFF caches responses. A missing or expired admin session is
rejected; no jobs are listed until the explicit feature gates are on.

The displayed delivery state is **not** evidence that the job was actually
processed. The actual news-research execution, source validation, job cancellation,
administrative rate limiting, database least-privilege roles, and VPS
data/service deployment approval remain independent future work.

## Migration 0003 — immutable research topic

The offline-only migration `0003_research_requests` introduces a one-to-one
`vns.research_requests` record for each new research job, tied to the existing
`vns.jobs` and outbox row in a single PostgreSQL transaction. Requests without
an explicit topic are rejected by the new API. On retry, an identical key/topic
returns the same UUID; the same key with a **different topic** fails with a
409 conflict and leaves existing data unchanged. The admin list still permits
`null` topics for earlier draft jobs. The migration is reversible and the
PostgreSQL dump/restore CI now verifies topic persistence.

**No source scraping, website fetching, fact verification or real research
execution is enabled by this change.** Any future source connector must
separately enforce SSRF protections, source provenance, copyright/rights
constraints and human editorial review before publishing.

## Source references (0004)

Offline migration 0004 adds candidate-only source provenance linked to a
research topic/job; the separate source-policy module screens metadata without
network requests. A source is not verified merely because it has an HTTPS URL,
and no real source fetch, external publication or research worker is active.
The authoritative reviewer workflow and least-privilege roles must be built
before any real editorial verification or deployment.

## Authenticated one-time evidence review (Git-only)

The same `VNS_ADMIN_JOBS_ENABLED` and `VNS_WEB_ADMIN_JOBS_ENABLED` gates now
protect `GET /admin/evidence?jobId=<uuid>` and
`POST /admin/evidence/review`, proxied through Next.js as
`/api/admin/evidence` and `/api/admin/evidence/review`. All requests
require a valid server-checked admin session; POST additionally requires the
exact configured HTTPS Origin. Responses are uncached and reveal only
allowlisted source metadata (up to 20 per research job). No arbitrary source
fetching is performed by these endpoints.

Only a strict JSON body `{"evidenceId":"<uuid>","decision":"verified|disputed|rejected"}`
can transition a PostgreSQL source from `candidate` to the specified
review verdict. The UPDATE is conditional on candidate status, so concurrent
or repeated decisions never rewrite existing evidence. A second decision
returns 409, a nonexistent identifier returns 404, and anonymous/CSRF attempts
are rejected. Status labels are editorial decisions only, **not** automatic
fact verification. A human reviewer must independently assess evidence.

**Identity limitation:** the current password-based shared admin session
supports no individual editor accounts. The mandatory reviewer column is
therefore recorded as `admin-session`, not a real person's identity. This
is sufficient to distinguish an authorized admin action from automated
candidate collection, but it is **not** a trustworthy individual audit trail.
Individual RBAC, named reviewer attribution, review rationale and full immutable
audit events remain mandatory before production use.

The feature is still disabled and not deployed on the VPS. GitHub Actions
runs real HTTP and PostgreSQL integration against disposable containers.

## Admin source-review controls (feature-gated UI)

The authenticated `/admin` job overview now includes a per-job, initially
closed `Quellen und Prüfstatus anzeigen` panel. Sources are fetched only
when an admin deliberately opens or refreshes a job panel, and never when
rendering the page. The panel lists the original URL, source publisher,
headline, specific claim and editorial status. External source links open in
a separate browser tab; the app does not download the page automatically.

An unreviewed candidate may be marked confirmed, disputed or rejected only
after selecting a decision and checking an explicit statement that the
editor personally inspected the original claim. A successful action is sent
through the existing protected API; uncertain network outcomes instruct the
admin to refresh before trying again. Once the persisted review state is no
longer `candidate`, the UI does not offer any revision control. Neither
reviewing a source nor viewing this list publishes or renders videos.

Because the shared password-based admin session does not distinguish users,
this remains a **preproduction preview**, not a complete authenticated
editorial accountability system. Individual identities, mandatory reason
notes, a complete audit trail, real source-rights reviews and a separately
approved backup/restore and VPS rollout are still required.

## 0005 – Editor identities and mandatory review audit (offline)

Migration 0005 adds the **inactive-by-default** `vns.editor_accounts` table
with unique editor usernames, allowed roles, scrypt password-hash storage and
activation state. This is only the schema: no individual login or provisioning
API is enabled yet, and there is no default editor account. Shared P1-06 admin
sessions must not be represented as individual identities.

Every _new_ source decision now requires a 20–500-character editorial reason,
validated on the UI, Next.js proxy, API and PostgreSQL. A one-time change from
`candidate` to a verdict atomically appends an event to
`vns.evidence_review_events`. The event contains previous and new verdict,
timestamp, reason and an actor label. Under ordinary database access its rows
cannot be edited or deleted by application code; transaction rollback removes
both the decision and event together. For the existing shared admin mechanism
the actor label remains `admin-session` and editor ID is NULL. No personal
audit identity is fabricated. Pre-migration decisions lack a reason and have
no retroactively invented events.

**Not tamper-proof against a database owner/superuser:** such actors can disable
triggers or change schema. Before production, issue least-privilege DB grants
and implement uniquely authenticated named editor logins, revocation, actual
role enforcement and independent backup/export of audit events. This
migration and HTTP route remain unactivated on the VPS.

## Dedicated personal editor sessions (API-only preview, disabled)

The internal API now provides a separate, opt-in `VNS_EDITOR_AUTH_ENABLED=true`
identity boundary. The feature requires the existing shared AdminAuth gate,
protected research-job gate, PostgreSQL Docker secret and exact HTTPS Origin.
The flag remains unset in Docker Compose and defaults to off. No account is
created or activated by this change.

`POST /editor/auth/login`, `POST /editor/auth/logout`,
`GET /editor/auth/session`, `GET /editor/me` and
`POST /editor/evidence/review` use existing individually provisioned active
editor accounts from migration 0005. Scrypt password verification is bounded,
errors reveal no account existence, and failures are rate-limited. A distinct
15-minute `__Host-vns_editor` Secure/HttpOnly/SameSite=Strict cookie is
used, never the shared admin cookie. Tokens are random and only hashed tokens
are held in process memory, so sessions end when the API process restarts.

Account state and role are read afresh from PostgreSQL on every authenticated
request. A deactivated account loses access on its next request. Only active
`reviewer` and `admin` roles can decide evidence; ordinary `editor` cannot.
The review transaction locks the account row to prevent concurrent account
revocation during commit, and atomically writes reviewer ID, real username,
reason and audit event. Once named editor auth is enabled, the old shared-admin
POST evidence-review endpoint is blocked, preventing an attribution bypass.

**Not enabled or deployed:** an individual login preview and Next.js BFF proxy
now exist, but remain behind independent web and API feature flags. No
provisioning/rotation UI exists and no accounts are seeded. Named editor
accounts cannot be used through the live website at this stage. DB least-privilege roles, distributed or durable sessions,
account lifecycle administration and independent audit retention remain
requirements for production. GitHub CI uses synthetic credentials and
disposable PostgreSQL; no live VPS services change.

## Personal editor browser integration (still disabled)

`VNS_WEB_EDITOR_AUTH_ENABLED=true` is a separate web-side gate requiring
`VNS_WEB_ADMIN_ENABLED=true` and `VNS_WEB_ADMIN_JOBS_ENABLED=true` plus
the existing validated API URL and public HTTPS origin. Its default is off.
When explicitly enabled, a new personal editor login form appears **inside**
the existing shared-admin-protected `/admin` preview. It exchanges individual
username/password for an independent `__Host-vns_editor` cookie through
`POST /api/editor/login`, exposes `GET /api/editor/me` for current
active role/identity and `POST /api/editor/logout` for revocation of the
in-memory browser session. The Next.js BFF strictly validates inputs and
accepts only an exact expected Secure/HttpOnly cookie format from the API.
It never sends raw password or access tokens in browser responses.

When the web editor flag is `true`, `POST /api/admin/evidence/review` forwards
**only** the individually authenticated editor cookie to
`/editor/evidence/review`. There is no fallback to the old shared admin
cookie: a missing, inactive or ordinary `editor` role cannot publish a
verdict. The existing shared admin session still protects the dashboard and
research job listing; it is not personal editorial identity. The protected
source-review form requires a written reason and manual confirmation.

For a coherent rollout, the **API** flag `VNS_EDITOR_AUTH_ENABLED`, its
already approved PostgreSQL/data/admin gates and this **web** flag must be
reviewed as a unit. Neither flag is enabled by the default Compose
configuration; the server has not been modified or restarted.

Outstanding before public or persistent rollout: securely provision named
editor accounts (there are none by default), password rotation/revocation UI,
least-privilege database credentials, verified backups, rate/cost controls,
SSRF-safe real sources and a separate VPS operator approval.

## 0006 – Inactive database role boundaries (Git-only)

Offline migration `0006_offline_role_boundaries` introduces two PostgreSQL
`NOLOGIN` roles with **no memberships and no passwords**:

- `vns_editor_provisioner` may create **inactive** named editor accounts
  (insert cannot set `active`), update an existing account's allowed
  display name, role, password hash or activation state, and inspect only
  non-secret account metadata. It cannot read stored password hashes,
  rename or delete identities, or modify editorial evidence or review logs.
- `vns_audit_reader` may read `vns.evidence_review_events` but cannot
  read named accounts or write audit records. Independent audit export,
  off-host retention and access authorization are **not** configured.

The new GitHub-Actions-only SQL integration applies the migration to a
disposable PostgreSQL instance, tests allowed operations and explicit
denials under `SET ROLE`, then rolls back; it runs twice to catch leaked
role grants. The real HTTP auth/job integration also runs against the
new schema. **No role has a LOGIN credential or a member in this change**,
and there is no editor account provisioned in any production database.

**Important:** the existing API still connects as the legacy `vns`
PostgreSQL user and does **not** switch to these roles. These roles are a
separately verifiable foundation, **not** a claim that least-privilege
runtime isolation or credential rotation is finished. Before production:
review database ownership and SECURITY INVOKER/DEFINER boundaries, separate
API runtime and job-dispatcher privileges, provision login credentials only
after operator approval, test realistic fail-closed grants, and approve
backup/restore and account lifecycle controls. The migration and rollback
must never be run on the VPS without explicit authorization.

## 0007 – API/dispatcher runtime SQL grants (Git-only, no activation)

Offline migration `0007_runtime_role_boundaries` introduces three separate
`NOLOGIN`, no-member roles. They are not usable by the live API or worker and
have no issued credentials:

- `vns_api_runtime`: reads required job, request, evidence and editor account
  tables (including password hashes, which personal login verification needs);
  can create job/outbox intent through the existing SECURITY INVOKER functions
  and write only specific review columns. It cannot create/change accounts,
  rewrite source provenance or insert audit events directly.
- `vns_outbox_dispatcher`: reads job/outbox rows and may update only transport
  delivery bookkeeping in `job_outbox`. It cannot create jobs, read editor
  passwords or modify source verdicts.
- `vns_review_event_writer`: owns the audit-capture trigger as a narrow
  SECURITY DEFINER role with a fixed search path and only audit-event INSERT
  permission. The API role does **not** receive audit INSERT privileges. A
  privileged migration operator is required to establish this ownership.

The migration also removes PUBLIC EXECUTE from the two internal research job
functions, granting execution specifically to the API runtime role; the
current owner-based CI API retains access. Disposable PostgreSQL tests cover
allowed job creation, real evidence verdict -> automatic audit append, outbox
acknowledgement, and forbidden account/audit/evidence mutations. The migration
is reverted before `0006`, and two full SQL migration cycles are exercised.

**Security boundary is not yet deployed or complete:** both API and dispatcher
still use their previous development/database settings. No login roles,
memberships or production credentials are created. API SQL grants do not
replace application authorization, authenticated editor identities or
independent audit retention; the API still has the ability to update review
metadata and must strictly authenticate/authorize callers. Before any VPS
migration: define owner separation, realistic grant-bound credentials,
test the actual live worker queries against this role, rotate secrets,
approve independently recoverable backups and a fail-closed rollout. Global
PostgreSQL roles are not contained in a `pg_dump --schema=vns --no-privileges`
archive; a production restoration requires a separately approved global-role
reconstruction procedure.

## 0008 – Session invalidation on account lifecycle changes (Git-only)

Offline-only migration `0008_editor_session_revocation` adds an integer
`auth_version` to each editor account and a PostgreSQL BEFORE UPDATE trigger.
Changes to `password_hash`, `role` or `active` increment that version.
An authorized provisioner cannot directly set the version; a matching-value
update does not revoke an unchanged account. Overflow fails closed.

The separately gated editor login stores the account's version with the
existing in-memory, hashed-token session. Every authenticated request
re-reads the active editor and checks this version. Named source decisions
also check it **under the locked PostgreSQL account row**, preventing an
out-of-date session from writing a review after a concurrent rotation.
Password changes, suspension, role changes and quick deactivate/reactivate
therefore invalidate previously issued sessions until a new login. In-memory
sessions still vanish on API restart.

CI-only tests use disposable accounts and real HTTP/PostgreSQL requests to
verify password rotation (old password and cookie rejected), immediate role
revalidation, disable/reactivate and rollback/reapplication. This is not an
operator-facing account-provisioning interface; account setup and rotation
still require separately approved privileged operations and safe secret
handling. No accounts are created or altered on the VPS, no feature flag is
turned on, and no persistent PostgreSQL role/login is provisioned.

## CI-only editor account lifecycle harness (not an operator CLI)

`scripts/ci_editor_account_lifecycle.mjs` is an **automated-test
harness only**. It refuses to run unless GitHub Actions-specific variables
and the known disposable local PostgreSQL endpoint match exactly. It is not
included as a public API route, admin UI, production container entrypoint or
operator command. No production account provisioning has been enabled.

Against a disposable CI database it executes account lifecycle operations
inside `BEGIN` / `SET LOCAL ROLE vns_editor_provisioner`. The role has
no LOGIN permission or members. Actions are strictly scoped to synthetic
`ci_*` usernames:

- Create an **inactive** editor, reviewer or admin test account. The initial
  password is salted using random bytes and stored as scrypt hash, never
  returned or logged.
- Activate or deactivate an existing synthetic account.
- Rotate its password and change its role. Migration 0008 automatically
  revokes previous browser sessions on these changes.

The test calls the account handler, then verifies actual HTTP login and
revocation, deactivated-user denial, role downgrade, hashed password storage,
and rejection of unauthorized usernames/extra account fields. Errors do not
contain password inputs. The existing production API login flags remain off.

**Still required before real user provisioning:** an operator-authorized
credential and administration interface with MFA or equivalent independent
authorization, correct separate PostgreSQL login grants, secure secret
input and rotation policy, lifecycle audit, approved off-host backups and
restore verification, recovery/rollback plan, and separate deployment
authorization. Never run the CI script by spoofing its environment variables
or against real personal accounts.

## Separate disposable PostgreSQL LOGINs (GitHub Actions only)

The test `scripts/test_db_login_roles.mjs` creates three **ephemeral** LOGIN
roles on the fixed loopback-only, GitHub Actions disposable PostgreSQL 17
instance: one each for the API runtime, outbox dispatcher and editor-account
provisioner. Every credential is freshly random and never logged, committed
or distributed to a VPS. The accounts are not created by any migration,
Docker Compose configuration or production startup. The test explicitly
uses PostgreSQL 17 membership flags `INHERIT TRUE, SET FALSE, ADMIN FALSE`,
checks separate authenticated database connections and prohibited role
switches, then tears down its test roles; the container is also destroyed.

The test confirms job persistence with the API role, outbox bookkeeping with
the dispatcher role, and inactive account insertion/activation with the
provisioner role. It checks denial of account administration to the API,
password visibility to the dispatcher, arbitrary job creation by the
dispatcher, direct audit modifications, and direct password readback by
the provisioner. All data and role names are synthetic and CI-only.

**Unresolved runtime gate:** a named source-review transaction currently
issues `SELECT ... FOR SHARE` on `vns.editor_accounts`. PostgreSQL requires
an UPDATE privilege on that relation for this lock, but `vns_api_runtime`
deliberately has no account UPDATE privilege. The test explicitly confirms
this is denied instead of silently granting unrestricted account mutation.
A narrowly scoped trusted database function or equivalent independently
audited solution is needed, followed by actual API HTTP coverage using a
least-privilege login, before a runtime credential cutover. This test is
**not evidence of a production-ready runtime login configuration**.

**Administrative action attribution is also still open:** a future account
lifecycle audit must record a verified operator identity and trustworthy
rotation/suspension events. The current CI harness has no independently
authenticated human operator and must not invent one. Any real
provisioning interface, login credentials, off-host audit retention,
backup/restore strategy and VPS deployment require explicit approval.

## 0009 – Scoped atomic named reviews (Git-only, not deployed)

A PostgreSQL review operation previously issued `SELECT ... FOR SHARE`
against `editor_accounts`, which requires UPDATE privileges that the
restricted API role intentionally does **not** have. Granting the API an
account UPDATE permission would weaken the account-lifecycle boundary.

Migration `0009_scoped_editor_review` replaces that direct two-statement
write with `vns.review_evidence_as_editor(uuid,text,text,uuid,integer)`,
a SECURITY DEFINER function with a fixed, explicit search path. A private
`vns_editor_review_executor` NOLOGIN role (no members) owns it. Only this
role can lock the account row and update the specific review columns;
the API has **EXECUTE only**, not direct UPDATE privileges on evidence or
editor accounts. The function checks active reviewer/admin role plus
auth_version while locking the editor row, writes a verdict once, and
creates one immutable review event through the separate existing audit
trigger. Missing, repeated or unauthorized review outcomes are mapped
to the existing API contract. The legacy shared admin authorization
remains under its previous feature gates and is not loosened.

The SQL migration has a CI-only down migration; PostgreSQL tests verify
role/member state, allowed verdicts, negative cases, audit attribution,
and denied direct writes. CI's real HTTP integration continues checking
deactivation, login, CSRF, and reviewer attribution; a separate disposable
LOGIN test verifies a fully restricted database connection. No real
operator roles, accounts, secrets, VPS services, or runtime config change
as part of this PR.

This function trusts the _authenticated API_ to supply the correct editor
identity/version: a stolen API database login could attempt calls with
other editor IDs. This is a least-privilege SQL integrity boundary, not
database-native verification of a browser session. Credential isolation,
separate operational login management, off-host audit retention, approved
backup/recovery, and explicit deployment authorization remain mandatory.

## 0010 – Operator-attributed account lifecycle ledger (offline only)

The reversible Git-only migration `0010_editor_account_lifecycle_audit`
adds an **empty** `vns.editor_operator_registry` and an append-only
`vns.editor_account_lifecycle_events` ledger. It creates a private
`vns_lifecycle_audit_writer` NOLOGIN/no-member function owner with
SELECT access only to the registry and INSERT access only to the events.
The lifecycle trigger runs on every account INSERT or UPDATE and rejects
**all account writes** unless PostgreSQL's authenticated `session_user`
has an explicitly enrolled, active registry record. Neither browser inputs,
arbitrary request headers, `SET ROLE`, custom session variables nor the
existing shared admin session can choose the operator identity.

The same transaction records editor account ID/name, authenticated
database login, operator UUID/label, event time, old/new role and active
state, session auth version and changed-field indicators. Password
rotations are recorded as a boolean **without the password, salt or hash**.
An unchanged UPDATE emits no misleading lifecycle event. Provisioners
cannot enroll themselves, read the operator registry or modify/delete
audit records. The independent `vns_audit_reader` role receives SELECT
on the new ledger for a future off-host export. Database owners and
superusers retain ultimate power and must be covered by separate
operational audits, not represented as tamper-proof.

Only disposable GitHub Actions test fixtures enroll synthetic database
identities (`postgres`, `vns`, and the ephemeral provisioning LOGIN).
No operator is pre-enrolled by migration or in the repository. In a
production installation, verified individually issued database login
credentials, explicit trusted operator enrollment/revocation, authorized
procedures and security review are all prerequisites. Until then the
migration remains **undeployed** and would fail closed for all account
writes. It does **not** itself implement multi-factor authentication,
a human-facing management UI, independently verified identity, secure
credential distribution, external audit retention or immutable off-host
logs. Real backup/restore and operator approval remain mandatory.
