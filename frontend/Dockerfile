# Frontend Dockerfile
FROM node:22-slim AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

WORKDIR /app

# Install dependencies (workspace install so pnpm-workspace.yaml allowBuilds applies)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/
RUN pnpm install --frozen-lockfile --filter ./frontend...

# Build frontend
FROM deps AS build
COPY frontend/ ./frontend/
RUN pnpm --filter ./frontend build

# Production image - serve with nginx
FROM nginx:alpine AS production

# Copy nginx config
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets
COPY --from=build /app/frontend/dist /usr/share/nginx/html

# Expose port
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
