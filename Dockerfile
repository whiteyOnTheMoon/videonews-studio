# Reproducible multi-workspace build; production images carry only runtime needs.
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

# Next.js standalone traces Web dependencies, instead of shipping the full workspace.
FROM node:22-bookworm-slim AS web
WORKDIR /workspace
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /workspace/apps/web/.next/standalone/ ./
COPY --from=builder --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# API/worker are compiled JS; worker has production-only BullMQ/Redis deps.
FROM node:22-bookworm-slim AS service-runtime
WORKDIR /workspace
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /workspace/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=node:node /workspace/packages/shared/dist ./packages/shared/dist
RUN mkdir -p node_modules/@vns && ln -s ../../packages/shared node_modules/@vns/shared
USER node

FROM node:22-bookworm-slim AS api-deps
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace @vns/api --workspace @vns/shared

FROM service-runtime AS api
COPY --from=api-deps --chown=node:node /workspace/node_modules ./node_modules
COPY --from=builder --chown=node:node /workspace/apps/api/dist ./apps/api/dist
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]

# Install only the worker's runtime dependencies, excluding dev and Next.js.
FROM node:22-bookworm-slim AS worker-deps
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace @vns/worker --workspace @vns/shared

FROM service-runtime AS worker
COPY --from=worker-deps --chown=node:node /workspace/node_modules ./node_modules
COPY --from=builder --chown=node:node /workspace/apps/worker/package.json ./apps/worker/package.json
COPY --from=builder --chown=node:node /workspace/apps/worker/dist ./apps/worker/dist
CMD ["node", "apps/worker/dist/index.js"]
