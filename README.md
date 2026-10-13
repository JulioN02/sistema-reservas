# Sistema de Reservas

Monorepo del microproducto **Sistema de Reservas**: gestión de citas y turnos para
negocios y profesionales que hoy atienden por WhatsApp y teléfono.

> **Estado**: v1 completa · 6 batches integrados en `main` · ver [Estado del proyecto](#estado-del-proyecto)
> **Evidencia del producto**: [problem-discovery](docs/problem-discovery.md) · [privacidad](docs/privacidad.md) · [deploy](docs/deploy.md)

---

## Índice

1. [Qué es](#qué-es)
2. [Stack](#stack)
3. [Setup desde cero](#setup-desde-cero)
4. [Variables de entorno](#variables-de-entorno)
5. [Estructura del monorepo](#estructura-del-monorepo)
6. [Contrato OpenAPI (API-first)](#contrato-openapi-api-first)
7. [Tests](#tests)
8. [Docker — stack local (< 2 min)](#docker--stack-local-2-min)
9. [Deploy](#deploy)
10. [Métricas del producto (KPIs)](#métricas-del-producto-kpis)
11. [Estado del proyecto](#estado-del-proyecto)

---

## Qué es

### El problema

Los negocios y profesionales que reciben citas por WhatsApp o teléfono gestionan
su agenda de forma manual (papel, memoria, chat). Eso produce: pérdida de control
de la disponibilidad (sobre-reservas accidentales y huecos que nadie detecta),
no-shows por falta de un recordatorio sistemático, fricción operativa (idas y
vueltas para reservar, confirmar, cancelar o reagendar) y ausencia total de
trazabilidad y métricas.

### La solución

Una aplicación web que:

- **Publica la disponibilidad** del negocio (horarios recurrentes − bloques
  puntuales − turnos ya reservados) como slots reservables, sin doble reserva.
- **Permite reservar en línea** en ≤ 3 pasos (servicio → horario → datos de
  contacto + consentimiento).
- **Confirma y recuerda** por email y por enlace de gestión, con el enlace como
  canal siempre disponible aunque el email falle.
- **Gestiona el ciclo de vida del turno**: pendiente → confirmado → completado |
  cancelado | no-show, con cancelación y reagendación.
- **Ofrece una vista del negocio**: turnos del día, historial filtrable y
  acciones sobre cada turno.
- **Mide desde el día 1**: eventos de negocio persistidos y un resumen de 4 KPIs.

El alcance v1 está congelado en la [ficha técnica](docs/problem-discovery.md).

---

## Stack

| Capa | Tecnología |
|---|---|
| API | Node 20 + TypeScript + Fastify 5 + Drizzle ORM |
| Base de datos | PostgreSQL 16 |
| Web | React 19 + Vite (SPA) + react-router |
| Contrato | OpenAPI 3.1 (`packages/contracts`) + redocly + `openapi-typescript` |
| Auth | sesión opaca en cookie `httpOnly` + argon2id |
| Email | Resend (`EmailChannel`) o `LogChannel` en desarrollo |
| Notificaciones | `ReminderScheduler` in-process (sweep con `FOR UPDATE SKIP LOCKED`) |
| Tests | Vitest (unit/integración) + Playwright (E2E) |
| Empaquetado | Docker + Docker Compose · deploy en Railway |

Monorepo con **pnpm workspaces** (`pnpm@10`, Node `>=20`).

---

## Setup desde cero

**Requisitos**: Node ≥ 20, pnpm 10, Docker + Docker Compose.

```sh
# 1. Dependencias del monorepo.
pnpm install

# 2. Variables de entorno locales (a partir del ejemplo, sin secretos).
cp .env.example .env

# 3. Base de datos de desarrollo + de test (contenedores Postgres 16).
pnpm db:up

# 4. Esquema y datos.
pnpm --filter @sistema-reservas/api db:migrate          # migraciones versionadas
pnpm --filter @sistema-reservas/api db:seed             # tenant demo + operador + servicios
pnpm --filter @sistema-reservas/api db:seed:sintetico   # opcional: 8 semanas de datos demo (KPIs)

# 5. Desarrollo (API + Web en paralelo).
pnpm dev
```

**URLs locales**

| Servicio | URL |
|---|---|
| API (health) | <http://localhost:3000/api/v1/health> |
| API (base v1) | <http://localhost:3000/api/v1> |
| Web (SPA) | <http://localhost:5173> |

**Credenciales del operador demo** (solo desarrollo, definidas en `.env`):
`operador@demo.local` / `demo-password-123`.

> **Nota sobre puertos**: el compose expone Postgres en `5432` (dev) y `5433`
> (test) por defecto. Si esos puertos están ocupados en tu máquina, ajusta
> `POSTGRES_PORT` / `POSTGRES_TEST_PORT` en `.env` (y la `DATABASE_URL` /
> `TEST_DATABASE_URL` en consecuencia).

---

## Variables de entorno

El archivo [`.env.example`](.env.example) es el **set completo documentado**
(valores por defecto y comentarios). La configuración del API se valida con zod
al arrancar (fail-fast): `apps/api/src/config/env.ts`.

| Variable | Para qué | Obligatoria |
|---|---|---|
| `DATABASE_URL` | conexión PostgreSQL | ✅ |
| `PORT` | puerto HTTP del API | ✅ |
| `DEFAULT_TENANT_SLUG` | tenant público (único activo en v1) | ✅ |
| `CORS_ORIGIN` | origen exacto de la SPA (nunca `*`) | ✅ |
| `COOKIE_SECURE` | cookie de sesión `Secure` (`true` solo con HTTPS) | ✅ |
| `SESSION_TTL_DAYS` | TTL de la sesión del operador | — |
| `REMINDER_LEAD_MIN` | anticipación del recordatorio (default 24 h) | — |
| `NOTIFICATION_CHANNEL` | `log` (dev/demo) o `email` (Resend) | ✅ |
| `RESEND_API_KEY` / `RESEND_FROM` | proveedor de email (solo si `email`) | condicional |
| `LOG_LEVEL` | nivel de log de pino | — |
| `OPERADOR_EMAIL` / `OPERADOR_PASSWORD` | credenciales del seed demo | solo seed |
| `POSTGRES_PORT` / `POSTGRES_TEST_PORT` / `API_PORT` / `WEB_PORT` | puertos del stack Docker | — |
| `VITE_API_URL` | base del API inyectada en el bundle web (**build-time**) | — |
| `E2E_BASE_URL` | URL base del stack para Playwright | — |

La tabla de valores de producción y las particularidades de Railway están en
[`docs/deploy.md`](docs/deploy.md).

---

## Estructura del monorepo

```
sistema-reservas/
├── apps/
│   ├── api/              # Fastify + Drizzle + PostgreSQL — dominio y endpoints /api/v1
│   │   ├── src/{routes,controllers,services,repositories,dto,db,infra,notificaciones}
│   │   ├── drizzle/      # migraciones versionadas (SQL)
│   │   └── Dockerfile    # imagen multi-stage, no-root, healthcheck
│   └── web/              # SPA React 19 + Vite — flujo público y panel del negocio
│       ├── src/{pages,components,lib,__tests__}
│       ├── e2e/          # suite Playwright (flujo público, panel, fallback de email)
│       └── Dockerfile    # build estático + Nginx no-root
├── packages/
│   └── contracts/        # OpenAPI 3.1 (fuente de verdad) + tipos generados + enums
├── docs/                 # deploy.md · privacidad.md · problem-discovery.md
├── docker-compose.yml    # db + db-test + migrate + api + web
├── .env.example          # set completo de variables de entorno
├── pnpm-workspace.yaml
└── vitest.config.ts      # proyectos vitest por paquete
```

El API sigue **vertical slices** por módulo (`routes/controllers/services/
repositories/dto`); el dominio se organiza por capacidades (agenda, reserva,
confirmación, cancelación, vista del negocio, métricas, aislamiento de tenant).

---

## Contrato OpenAPI (API-first)

`packages/contracts/openapi.yaml` es la **fuente de verdad** del API v1. El
contrato se define **antes** del código y ningún cambio incompatible rompe la
compatibilidad (un cambio de ese tipo exige una nueva versión).

- **Gate de contrato** (redocly, 0 errores):
  ```sh
  pnpm --filter @sistema-reservas/contracts lint:contract
  ```
- **Tipos compartidos** generados desde el YAML:
  ```sh
  pnpm --filter @sistema-reservas/contracts generate:types   # → src/generated/api.ts
  ```
  Los consumen tanto `apps/api` como `apps/web`; los enums se definen con el
  patrón `const X = {...} as const` + `type T = (typeof X)[keyof typeof X]`.

**Convenciones del contrato**: identificadores de dominio en español; error
RFC 7807 `application/problem+json`; `slot_key` = `<fecha_hora_inicio_utc_ISO8601>|<servicio_id>`.
El contrato se verifica en tests de conformancia (rutas registradas, códigos
documentados y respuestas contra los esquemas).

---

## Tests

El runner es **Vitest** (unit + integración) y **Playwright** (E2E).

```sh
# Unit + integración (necesita la BD de test; usa TEST_DATABASE_URL).
TEST_DATABASE_URL="postgres://postgres:postgres@localhost:5433/sistema_reservas_test" pnpm test

# Cobertura del API (gate ≥ 70 % de líneas en los servicios críticos).
pnpm --filter @sistema-reservas/api test:coverage

# Gate de contrato.
pnpm --filter @sistema-reservas/contracts lint:contract

# Lint del monorepo (0 errores).
pnpm lint
```

Los tests de **integración** corren contra PostgreSQL real (`db-test`); en el
compose está en `5433`. Cubren, entre otros: reserva 201/409 con `tstzrange`,
concurrencia (100 POST al mismo slot → exactamente 1×201), aislamiento de tenant,
anonimización (PRV-02) y los KPIs contra un fixture (± 0,1 pp).

### E2E (Playwright) contra el stack Docker

```sh
# 1. Instalar el navegador (una vez).
pnpm --filter @sistema-reservas/web e2e:install

# 2. Levantar el stack (ver la sección Docker) y correr los flujos.
pnpm --filter @sistema-reservas/web e2e
```

Los flujos E2E cubren: reserva → confirmación por enlace → cancelación; login →
vista del día; y el flujo sin email (`LogChannel`), que demuestra que el enlace
de gestión funciona aunque el envío de email falle.

---

## Docker — stack local (< 2 min)

El `docker-compose.yml` levanta el stack completo con un flujo de dependencias
determinista:

```
db (healthy) ─▶ migrate (db:migrate + db:seed, one-shot) ─▶ api (healthy) ─▶ web
```

```sh
cp .env.example .env
docker compose up --build

# API   → http://localhost:3000/api/v1/health
# Web   → http://localhost:8080
```

Con las imágenes ya construidas, `docker compose up` aplica migraciones + seed y
deja `api`, `web` y `db` arriba en **< 2 minutos** (CA-INT-03).

Para un stack aislado (E2E / CI) sin chocar con el de desarrollo, usar otro
proyecto y otros puertos — detalles en [`docs/deploy.md`](docs/deploy.md) §6.

---

## Deploy

Guía completa: [`docs/deploy.md`](docs/deploy.md). Resumen:

- **Plataforma**: Railway (decisión A6) — `api` (Dockerfile), `web` (build
  estático + Nginx) y plugin PostgreSQL.
- **Migraciones**: como *release command* antes del start
  (`pnpm --filter @sistema-reservas/api db:migrate`); nunca al arrancar.
- **Escala = 1** en el API: el `ReminderScheduler` corre in-process; con más de
  una réplica se duplicarían los recordatorios.
- `VITE_API_URL` es **build-time**: al cambiarla hay que reconstruir el web.

---

## Métricas del producto (KPIs)

La instrumentación de eventos de negocio es parte del producto (RF-21), no solo
del logging. `GET /api/v1/metricas/resumen` expone 4 KPIs, medidos desde el día 1:

| # | KPI | Ventana | Cálculo |
|---|---|---|---|
| 1 | **Reservas creadas** | 8 semanas ISO | eventos `reserva_creada` por semana |
| 2 | **Tasa de no-show** | 4 semanas | `no_show` ÷ (`completado` + `no_show`) |
| 3 | **Ocupación de agenda** | semana actual | turnos activos ÷ slots ofrecidos (mismo `calcularSlots`) |
| 4 | **Cancelaciones** | 4 semanas | cantidad + tasa (cancelados ÷ creados) |

El seed sintético (`db:seed:sintetico`) genera 8 semanas de datos consistentes y
un fixture de KPIs esperados que alimenta la demo y las pruebas de rendimiento.
Sin datos suficientes, los KPIs se devuelven como `null` (nunca un valor
inventado).

---

## Estado del proyecto

v1 completa. Seis batches integrados en `main` mediante PR:

| Batch | PR | Alcance |
|---|---|---|
| 1 — Fundación | #2 | monorepo, contrato OpenAPI, scaffolds, esquema multi-tenant + seed |
| 2 — Auth + agenda | #4 | login/logout/me, cálculo de slots, gestión de la agenda |
| 3 — Reserva + confirmación | #6 | reserva con claim atómico, confirmación por enlace, recordatorios |
| 4 — Web UI | #8 | flujo público de reserva + página de gestión del turno |
| 5 — Panel + métricas | #10 | vista del día, historial, 4 KPIs, panel del negocio |
| 6a — Hardening | #12 | seguridad, privacidad, concurrencia, cobertura, conformancia |

El **batch 6b** (pulido de cierre: seed sintético, Docker + deploy, E2E y
documentación) vive en la rama `feat/batch-6b-cierre`.

Más evidencia del ciclo Product Engineer en este mismo folder:
[ficha técnica y descubrimiento del problema](docs/problem-discovery.md) ·
[política de privacidad](docs/privacidad.md) ·
[guía de deploy](docs/deploy.md).
