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
