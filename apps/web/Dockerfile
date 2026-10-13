# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# apps/web/Dockerfile — SPA React 19 + Vite servida por Nginx (no-root)
#
# Contexto de build: la RAÍZ del monorepo. Ejemplo:
#   docker build -f apps/web/Dockerfile -t sistema-reservas-web .
#
# VITE_API_URL es BUILD-TIME (Vite la inyecta en el bundle):
#  - Compose local: por defecto vacío → la SPA usa `/api/v1` same-origin y Nginx
#    hace de proxy a la API (`proxy_pass http://api:3000`). Sin CORS.
#  - Railway (orígenes separados): pasar la URL pública del API, p. ej.
#      docker build -f apps/web/Dockerfile --build-arg VITE_API_URL=https://api.tudominio.com/api/v1 -t web .
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# --- deps: dependencias completas (Vite es devDependency) --------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- build: bundle estático (tsc --noEmit && vite build) ---------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages/contracts ./packages/contracts
# Build arg con la base del API (Vite la inyecta en el bundle — BUILD-TIME).
# Default `/api/v1` (same-origin, proxy Nginx del compose local). Para orígenes
# separados (Railway) pasar la URL pública completa, p. ej.
#   --build-arg VITE_API_URL=https://api.tudominio.com/api/v1
# IMPORTANTE: nunca pasar cadena vacía (rompe la base del apiClient, que usa
# `?? "/api/v1"` y no aplica el fallback con "").
ARG VITE_API_URL=/api/v1
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @sistema-reservas/web build

# --- runtime: Nginx no-root (uid 101) escuchando en 8080 ---------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
