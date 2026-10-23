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

- No UI form for research jobs is included yet; only an intentionally
  disabled-by-default internal API/BFF endpoint.
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
