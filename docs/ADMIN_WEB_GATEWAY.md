# P1-06 – Server-rendered Next.js admin gateway (draft)

**Scope:** GitHub PR only. No VPS restart, new GHCR images, public web routing, credentials, database or backups are authorized by this change.

The existing AdminAuth API from P1-06 remains unchanged. This addition puts a **server-side Next.js BFF** between the browser and the internal API, and provides:

- \`GET /admin/login\`: browser password form shown only with explicit opt-in.
- \`POST /api/admin/login\`: same-origin JSON password submitted to the Next.js server, then forwarded server-to-server only to the internal API's \`POST /auth/login\`. The web server holds no password hash.
- \`GET /admin\`: Next.js server component validates the \`__Host-vns_session\` token with the API \`GET /admin/me\` for **each request**, without caching. Missing/expired/invalid sessions redirect to the login view; disabled configuration returns 404.
- \`POST /api/admin/logout\`: same-origin, authenticated BFF call to the API's logout endpoint. The secure browser cookie is expired on success.
- The browser **never connects directly** to \`http://api:4000\`, nor receives the internal address or session token in a JSON response. The browser only receives its HTTP-only, Secure, SameSite-Strict cookie.

The gateway is **disabled by default** and only enables when all of the following are set explicitly on the web service: \`VNS_WEB_ADMIN_ENABLED=true\`, \`VNS_ADMIN_ORIGIN=https://<approved-host>\` and \`VNS_API_INTERNAL_URL=http://api:4000\` (for local automated testing, loopback at port 4000 is allowed). The API separately requires \`VNS_ADMIN_AUTH_ENABLED=true\`, a server-only \`VNS_ADMIN_PASSWORD_HASH\` and exactly the same HTTPS \`VNS_ADMIN_ORIGIN\`. Nothing sets these flags in the current Docker Compose stack. Do not use an unapproved origin or fabricate credentials for the VPS.

The BFF rejects wrong/missing Origin on mutations (CSRF), invalid JSON and oversize request bodies. It sends only a validated session cookie upstream, accepts only the precise secure Set-Cookie shape currently emitted by our own API, never forwards arbitrary upstream headers/responses, and rejects API errors or timeouts with a generic failure. Server-side authorization treats an unavailable or rejecting API as **unauthorized**, never as permission to view the admin placeholder. No browser-accessible arbitrary proxy endpoint is provided.

## Security limitations / deployment blockers

This remains an **internal security prototype** and is not approved for public or production deployment. Before any activation:

1. Deploy and test both components together under an HTTPS ingress that is **separately approved**, including Origin validation and proxy behavior; no direct public API exposure, no public plain HTTP.
2. Arrange secure secret provisioning without putting passwords, salts, session tokens or hashes in Git, chat, JS bundles or logs.
3. Address the **current API in-memory session/rate-limit** design: web-to-API calls all originate from the web container IP, so the current API's per-IP rate limit becomes _shared across users_ and is not a robust per-client distributed limiter. Reevaluate anti-brute-force controls in a reviewed design before production.
4. Assess persistent sessions, MFA, account recovery, revocation, observability without secrets, and rate limiting at trusted edge; none exists here.
5. The admin page is a protected **placeholder** and no editorial actions, database mutations, media processing or automatic publication are enabled. Permissions for any future writing API endpoints must be checked on the API server, not merely hidden by a Web UI.

The absence of backups remains accepted only for hobby code, **not** authorization to create real PostgreSQL records on the VPS. Existing pinned preview containers remain unchanged.

## Tests

The monorepo CI runs the existing API tests and new web BFF unit tests. The web tests simulate requests without real credentials or external services: disabled config, exact HTTPS/internal target checks, missing/duplicate/forged cookies, CSRF rejection, request size limit, strict Set-Cookie forwarding, logout invalidation, API failure and authorization denial. Additional automated end-to-end HTTPS tests and independent security review are still required before activation. This PR does not prove secure deployment.

As with earlier steps, merge requires green CI and an independent review or a **new specific, explicitly authorized exception only for this PR**. Prior approvals for PR #78 or #79 do not apply.
