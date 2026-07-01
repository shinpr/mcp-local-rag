# Backend API server Dockerfile
FROM node:22-slim AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/
RUN pnpm install --frozen-lockfile --filter '!./frontend'

# Build backend
FROM deps AS build
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# Production image
FROM node:22-slim AS production

RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

WORKDIR /app

# Copy built output and dependencies
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules

# Create data directories
RUN mkdir -p /app/lancedb /app/models /app/uploads

# Expose API port
EXPOSE 3939

# Health check (embedder + first-run model download can take several minutes on slow CPUs)
HEALTHCHECK --interval=10s --timeout=5s --start-period=180s --retries=12 \
  CMD node -e "fetch('http://localhost:3939/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# index.js routes argv to handleCli(); cli-main.js is a library module with no entry point
CMD ["node", "dist/index.js", "serve"]
