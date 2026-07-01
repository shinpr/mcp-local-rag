# syntax=docker/dockerfile:1

# Backend API server Dockerfile
FROM node:22-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
ENV HUSKY=0
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

WORKDIR /app

# Full dev dependencies for TypeScript build — cached until lockfile changes
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/
RUN --mount=type=cache,id=pnpm-store-api,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --filter '!./frontend' --ignore-scripts && \
    pnpm rebuild better-sqlite3 esbuild onnxruntime-node sharp

# Production runtime deps — prune devDeps without re-running lifecycle hooks
FROM deps AS prod-deps
RUN pnpm prune --prod --ignore-scripts --config.confirmModulesPurge=false

# Static assets (rarely change)
FROM base AS skills
COPY skills/ ./skills/

# Entrypoint script (rarely changes)
FROM base AS entrypoint
COPY scripts/docker-api-entrypoint.sh /app/scripts/docker-api-entrypoint.sh

# Build backend
FROM deps AS build
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# Production image
FROM node:22-slim AS production

ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision="${GIT_REVISION}"

WORKDIR /app

# Large prod node_modules layer — independent of src/ changes
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=skills /app/skills ./skills
COPY --from=entrypoint /app/scripts/docker-api-entrypoint.sh /app/scripts/docker-api-entrypoint.sh

# Create data directories
RUN mkdir -p /app/lancedb /app/models /app/uploads \
    && chmod +x /app/scripts/docker-api-entrypoint.sh

# Expose API port
EXPOSE 3939

# Health check (embedder + first-run model download can take several minutes on slow CPUs)
HEALTHCHECK --interval=10s --timeout=5s --start-period=180s --retries=12 \
  CMD node -e "fetch('http://localhost:3939/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# index.js routes argv to handleCli(); cli-main.js is a library module with no entry point
ENTRYPOINT ["/app/scripts/docker-api-entrypoint.sh"]
CMD ["node", "dist/index.js", "serve"]
