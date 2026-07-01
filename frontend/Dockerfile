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

# Nginx config (rarely changes — keep separate from frontend source)
FROM base AS nginx-config
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Build frontend
FROM deps AS build
COPY frontend/index.html frontend/vite.config.ts frontend/vite-env.d.ts ./frontend/
COPY frontend/tsconfig.json frontend/tsconfig.app.json frontend/tsconfig.node.json ./frontend/
COPY frontend/public ./frontend/public
COPY frontend/src ./frontend/src
RUN pnpm --filter ./frontend build

# Production image - serve with nginx
FROM nginx:alpine AS production

COPY --from=nginx-config /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
