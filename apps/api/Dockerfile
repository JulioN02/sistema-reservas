# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# apps/api/Dockerfile — API Fastify + Drizzle (multi-stage: deps → build → runtime)
#
# Contexto de build: la RAÍZ del monorepo (necesita pnpm-lock.yaml y el
# workspace). Ejemplo:
#   docker build -f apps/api/Dockerfile -t sistema-reservas-api .
#
# Notas de runtime:
#  - El API ejecuta TypeScript directamente con `tsx`: `server.ts` y el seed
#    corren sin compilar, y el paquete `@sistema-reservas/contracts` se consume
#    como TS fuente (ver packages/contracts/package.json → exports: ./src/index.ts).
#    Por eso `tsx` es una dependencia de PRODUCCIÓN del API (apps/api/package.json).
#  - Runtime instala SOLO dependencias de producción (`pnpm install --prod`).
#
# Railway (release command):
#  - Pre-deploy Command del servicio: `pnpm --filter @sistema-reservas/api db:migrate`
#    (aplica las migraciones versionadas de apps/api/drizzle antes del start).
#  - Start Command: el CMD de esta imagen (`pnpm --filter @sistema-reservas/api start`).
#  - Escala = 1 réplica (el scheduler de recordatorios es in-process; >1 duplica
#    envíos — ver docs/deploy.md y riesgo R-D2 del diseño).
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# --- deps: dependencias completas (incl. dev) para el typecheck -------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- build: typecheck del API (tsc --noEmit, gate de calidad) ----------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages/contracts ./packages/contracts
RUN pnpm --filter @sistema-reservas/api build

# --- runtime: solo dependencias de producción + fuentes necesarias -----------
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# Fuentes del API + migraciones + config de drizzle-kit (release command).
COPY --from=build /app/apps/api/src ./apps/api/src
COPY --from=build /app/apps/api/drizzle ./apps/api/drizzle
COPY --from=build /app/apps/api/drizzle.config.ts ./apps/api/drizzle.config.ts
COPY --from=build /app/apps/api/tsconfig.json ./apps/api/tsconfig.json
# Contratos consumidos como TS fuente.
COPY --from=build /app/packages/contracts/src ./packages/contracts/src
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json

# Usuario no-root (imagen node ya trae el usuario `node`, uid 1000).
USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@sistema-reservas/api", "start"]
