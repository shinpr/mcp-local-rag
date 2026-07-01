# syntax=docker/dockerfile:1

# Frontend Dockerfile
FROM node:22-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

WORKDIR /app

# Install dependencies (workspace install so pnpm-workspace.yaml allowBuilds applies)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/
RUN --mount=type=cache,id=pnpm-store-web,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --filter ./frontend... --ignore-scripts && \
    pnpm rebuild esbuild

# Nginx config template (rendered at container start from MAX_UPLOAD_SIZE_MB)
FROM base AS nginx-config
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Build frontend
FROM deps AS build
COPY frontend/index.html frontend/vite.config.ts frontend/vite-env.d.ts ./frontend/
COPY frontend/tsconfig.json frontend/tsconfig.app.json frontend/tsconfig.node.json ./frontend/
COPY frontend/public ./frontend/public
COPY frontend/src ./frontend/src
RUN pnpm --filter ./frontend build

# Production image - serve with nginx
FROM nginx:alpine AS production

RUN apk add --no-cache gettext

COPY --from=nginx-config /etc/nginx/templates/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=nginx-config /docker-entrypoint.sh /docker-entrypoint.sh
COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]
