# Development environment (P1-03)

## Boundaries
- Node.js 22 LTS+ (up to Node.js 24), npm 10+, TypeScript, npm workspaces, Next.js 16.
- Local development only: no Docker containers, PostgreSQL, Redis, or remote integrations are started by these commands.
- API uses loopback `127.0.0.1:4000` unless overridden in an explicitly isolated container at P1-04.
- Worker executable is a scaffold and exits; job queues arrive in P1-07. Rendering stays capped at one job when implemented.
- Next.js page is placeholder only. Admin authentication is part of P1-06; do not expose as a public admin page.
- Copy `.env.example` to a private `.env` if needed. Never commit credentials.

## Installation and checks

```sh
node --version
npm --version
npm install --no-audit --no-fund
npm run build
npm run typecheck
npm run lint
npm test
npm run format:check
```

The root scripts build `@vns/shared` first so API, web and worker can import its compiled ESM/types. Use `npm run dev:web` and `npm run dev:api` in separate terminals.

**Reproducibility prerequisite:** P1-03 is not complete until `package-lock.json` is generated with npm, reviewed, committed and installation succeeds with `npm ci`. Do not treat `npm install` without a lockfile as reproducible.

## Dependency and resource policy

- Next.js pinned to an October 2026 stable security-patched 16.x version rather than using an old unsupported major.
- No external TTS, LLM, YouTube, billing or database services contacted by the scaffold.
- Nothing is deployed to VPS until isolated Docker design and resource constraints pass P1-04.
- Do not open production ports or touch existing cloudflared/Curvenfunk services.

## Future issue ownership

- P1-04: Docker Compose, network, resource budgets, healthchecks and ingress.
- P1-05: PostgreSQL schema and reversible migrations.
- P1-06: server-side authentication, sessions and admin RBAC.
- P1-07: Redis/BullMQ durability, idempotency and worker lifecycle.
- P1-08: full CI, lockfile checks, integration tests and policy enforcement.
