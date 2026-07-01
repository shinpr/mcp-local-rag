# Frontend Dockerfile
FROM node:22-slim AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

WORKDIR /app

# Install dependencies
FROM base AS deps
COPY frontend/package.json frontend/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile 2>/dev/null || npm install

# Build frontend
FROM deps AS build
COPY frontend/ ./
RUN pnpm build

# Production image - serve with nginx
FROM nginx:alpine AS production

# Copy nginx config
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets
COPY --from=build /app/dist /usr/share/nginx/html

# Expose port
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
