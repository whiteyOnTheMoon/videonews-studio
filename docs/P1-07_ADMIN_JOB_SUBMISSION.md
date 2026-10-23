# P1-07 — Protected internal research job submission

Status: **implemented in Git, disabled by default, not deployed**.

## Flow

1. The browser may POST to `/api/admin/jobs` (Next.js BFF) **only** when
   `VNS_WEB_ADMIN_JOBS_ENABLED=true` and the existing HTTPS Admin BFF
   configuration is valid.
2. The BFF validates an exact `Origin`, exactly one valid
   `__Host-vns_session` cookie, JSON format, a 1024-byte size limit and
   the strictly allowlisted payload shape:
   `{"kind":"research","idempotencyKey":"<24-80 ASCII letters/digits/_/->"}`.
   It passes only these vetted values to the internal API.
3. The API route `POST /admin/jobs` is independently disabled unless
   `VNS_ADMIN_JOBS_ENABLED=true`, existing AdminAuth is configured and a
   readable `/run/secrets/postgres_password` is present. It independently
   enforces an authenticated 15-minute admin session, exact configured HTTPS
   origin, strict payload validation and bound size.
4. A parameterized PostgreSQL query calls `vns.create_job_with_outbox` to
   persist an idempotent `research` job and outbox intent in a single
   transaction. The same idempotency key returns the same job ID.
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
  The form does not accept a research topic because editorial execution is
  not implemented.
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
enabled, the browser generates a random idempotency key and keeps it across
network retries until a confirmed PostgreSQL `202 Accepted`. The form says
**vormerken**, never "start research": it stores a database intent only.

`GET /api/admin/jobs` (Next.js BFF) forwards the validated secure admin
session cookie to the independently authenticated `GET /admin/jobs` API.
The API reads the 20 most recent research jobs by created time from
`vns.jobs` joined to `vns.job_outbox`. Only UUID, job kind, persisted
job status, outbox delivery state, and ISO timestamp leave the API.
Idempotency keys, database details and errors are never returned. Neither the
server nor the BFF caches responses. A missing or expired admin session is
rejected; no jobs are listed until the explicit feature gates are on.

The displayed delivery state is **not** evidence that the job was actually
processed. The eventual job lifecycle, real topic input, job cancellation,
administrative rate limiting, database least-privilege roles, and VPS
data/service deployment approval remain independent future work.
