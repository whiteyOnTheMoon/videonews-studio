# Single build with shared dependencies; app targets share the same runtime layers.
FROM node:22-bookworm-slim AS builder
WORKDIR /workspace
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
WORKDIR /workspace
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=builder --chown=node:node /workspace/ /workspace/
USER node

FROM runtime AS web
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "apps/web", "-H", "0.0.0.0", "-p", "3000"]

FROM runtime AS api
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]

FROM runtime AS worker
CMD ["node", "apps/worker/dist/index.js"]
