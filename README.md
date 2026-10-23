# VideoNews Studio

Private, editorially supervised platform for producing sourced explainer videos.

> Phase P1-03: development scaffold only. There is no autonomous upload, rendering or production authentication in this branch.

## Layout

- `apps/web` – Next.js 16 frontend
- `apps/api` – Node.js HTTP API scaffold (`GET /healthz`)
- `apps/worker` – Node.js worker scaffold (render concurrency fixed to one; no queues yet)
- `packages/shared` – shared TypeScript types and helpers
- `docs/DEVELOPMENT.md` – environment, build and security notes

## Quick start

Requires Node.js 22+ and npm 10+. At this stage, package lockfile generation and CI install verification are pending; see the development guide.

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm run format:check
```

In two development shells:

```bash
npm run dev:web
npm run dev:api
```

Defaults: web http://127.0.0.1:3000 and API http://127.0.0.1:4000/healthz.

The project is planned for an isolated Docker Compose stack below `/home/ap/www/videonews-studio` (P1-04), without interfering with existing VPS projects.

## Governance

Every code change starts with a GitHub issue. Work in a branch; review and test its PR before merging. The free private-repo plan cannot enforce branch protection; this is an explicitly documented restriction, not a waiver of the review rule. No paid services without approval.
