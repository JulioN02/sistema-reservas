# Deploy — Sistema de Reservas

Guía de despliegue del monorepo `apps/api` + `apps/web` sobre **Railway**
(decisión A6 del diseño). Incluye también el uso del stack local con Docker
Compose, que es la base reproducible para desarrollo, CI y E2E.

> **Estado**: las imágenes Docker y el compose están lista para desplegar, pero
> el deploy real es un **gate del usuario** (presupuesto Railway R-D6 y dominio
> real con SPF/DKIM Resend R-D3). Nada de esto se despliega automáticamente.

---

## 1. Arquitectura de despliegue

| Servicio | Artefacto | Notas |
|---|---|---|
| `api` | `apps/api/Dockerfile` (multi-stage) | Dockerfile en Railway; **escala = 1**. |
| `web` | `apps/web/Dockerfile` (build estático + Nginx no-root) | Nginx sirve la SPA. |
| `db` | Plugin **PostgreSQL** de Railway | Provee `DATABASE_URL`. |

```
Navegador ──HTTPS──▶ web (Nginx, SPA estática)
                          │  VITE_API_URL (build-time)
                          ▼
                      api (Fastify)  ──▶  Postgres (plugin)
                          │  scheduler de recordatorios in-process
                          ▼
                      Resend (email) / LogChannel (dev)
```

---

## 2. Consideraciones críticas

### 2.1 Escala = 1 en el API (OBLIGATORIO)

El `ReminderScheduler` corre **dentro del proceso del API** (sweep cada 60 s con
`FOR UPDATE SKIP LOCKED`). Con **más de 1 réplica** cada instancia haría su sweep
y podría **duplicar envíos de recordatorio** (riesgo R-D2 del diseño).

- En Railway: `api` → **Settings → Deploy → Replicas = 1**. No habilitar autoscaling.
- Camino de mejora futuro: mover el scheduler a un worker separado (p. ej. BullMQ).

### 2.2 Migraciones como release command

El diseño exige aplicar las migraciones **antes** del start, nunca al arrancar:

- `api` → **Settings → Deploy → Pre-deploy Command**:
  ```sh
  pnpm --filter @sistema-reservas/api db:migrate
  ```
- El **Start Command** es el `CMD` de la imagen:
  ```sh
  pnpm --filter @sistema-reservas/api start
  ```
- Regla RNF-09: **una migración por iteración; nunca editar migraciones ya
  aplicadas**. Las migraciones versionadas viven en `apps/api/drizzle/`.
- Seed idempotente (opcional, entornos demo):
  ```sh
  pnpm --filter @sistema-reservas/api db:seed
  ```

### 2.3 `VITE_API_URL` es BUILD-TIME

Vite **inyecta** `VITE_API_URL` en el bundle durante el build. No es editable en
runtime. En Railway (web y api en orígenes distintos) hay que construir el web
con la URL pública del API:

```sh
docker build -f apps/web/Dockerfile \
  --build-arg VITE_API_URL=https://TU-API.up.railway.app/api/v1 \
  -t sistema-reservas-web .
```

- Si `VITE_API_URL` queda **vacío**, la SPA usa `/api/v1` same-origin y confía en
  el proxy de Nginx (`proxy_pass http://api:3000`). Esto sirve para el compose
  local, **no** para orígenes separados.
- Al cambiar `VITE_API_URL` hay que **rebuild** del servicio web.

### 2.4 CORS y cookies

- `CORS_ORIGIN` debe ser el **origen exacto** del web (nunca `*`), porque la
  sesión viaja en la cookie `sid` con `credentials: true`.
  Ej.: `CORS_ORIGIN=https://TU-WEB.up.railway.app`.
- `COOKIE_SECURE=true` en producción (HTTPS). Si el web y el api comparten
  origen (proxy Nginx), no hay CORS de por medio.

---

## 3. Variables de entorno (Railway)

Definir en **api → Variables** (todas las del diseño §10):

| Variable | Valor (ejemplo prod) | Obligatoria |
|---|---|---|
| `DATABASE_URL` | provista por el plugin Postgres | ✅ |
| `PORT` | `3000` (Railway inyecta `$PORT`) | ✅ |
| `DEFAULT_TENANT_SLUG` | `demo` | ✅ |
| `CORS_ORIGIN` | `https://TU-WEB.up.railway.app` | ✅ |
| `COOKIE_SECURE` | `true` | ✅ |
| `SESSION_TTL_DAYS` | `7` | — |
| `REMINDER_LEAD_MIN` | `1440` | — |
| `NOTIFICATION_CHANNEL` | `email` (prod) / `log` (demo) | ✅ |
| `RESEND_API_KEY` | secreto Resend | solo `email` |
| `RESEND_FROM` | `no-reply@tudominio.com` | solo `email` |
| `LOG_LEVEL` | `info` | — |
| `OPERADOR_EMAIL` / `OPERADOR_PASSWORD` | credenciales del seed (demo) | solo seed |

> `DEFAULT_TENANT_SLUG` debe coincidir con el tenant sembrado. Ver también
> `.env.example` para el set completo y sus defaults.

---

## 4. Dominio y email (Resend)

1. Conectar el **dominio** del web en Railway (Settings → Networking → Custom
   Domain).
2. **SPF/DKIM** (tarea de deploy, R-D3): en el proveedor de DNS, agregar los
   registros del subdominio de envío de Resend:
   - **SPF** — registro `TXT` con el `include` de Resend.
   - **DKIM** — registro `CNAME` con la clave pública de Resend.
3. Verificar el dominio en el dashboard de Resend.
4. **Fallback garantizado**: aunque el email falle, el **enlace de gestión**
   funciona siempre (CA-CMR-04). El email es un canal adicional, no un requisito
   para confirmar/cancelar.

---

## 5. Build settings en Railway

- **api**: Runtime = Dockerfile → `apps/api/Dockerfile` (contexto = raíz del repo).
  - Watch paths: `/apps/api/**`, `/packages/contracts/**`, `/pnpm-lock.yaml`.
- **web**: Runtime = Dockerfile → `apps/web/Dockerfile` (contexto = raíz del repo).
  - Build arg: `VITE_API_URL=https://TU-API.up.railway.app/api/v1`.
  - Watch paths: `/apps/web/**`, `/packages/contracts/**`, `/pnpm-lock.yaml`.

---

## 6. Stack local con Docker Compose

Levanta `db` + `db-test` + `migrate` + `api` + `web`. Flujo de dependencias:

```
db (healthy) ─▶ migrate (db:migrate + db:seed, one-shot) ─▶ api (healthy) ─▶ web
```

```sh
# Copiar variables de entorno.
cp .env.example .env

# Levantar el stack completo (construye las imágenes la primera vez).
docker compose up --build

# API   → http://localhost:3000/api/v1/health
# Web   → http://localhost:8080
```

**CA-INT-03**: con las imágenes ya construidas, `docker compose up` aplica
migraciones + seed y deja `api`+`web`+`db` arriba en **< 2 min**.

### Stack aislado (E2E / CI)

Para no chocar con un stack de desarrollo ya levantado, usar otro proyecto y
puertos distintos. Con `-f docker-compose.yml` explícito **no** se carga el
`docker-compose.override.yml` local:

```sh
API_PORT=3100 WEB_PORT=8180 POSTGRES_PORT=5441 POSTGRES_TEST_PORT=5442 \
  CORS_ORIGIN=http://localhost:8180 \
  docker compose -p sistema-reservas-e2e -f docker-compose.yml up -d --build

# ... correr los tests E2E ...
pnpm --filter @sistema-reservas/web e2e

# Limpiar.
docker compose -p sistema-reservas-e2e -f docker-compose.yml down -v
```

### Construir las imágenes sueltas

```sh
docker build -f apps/api/Dockerfile -t sistema-reservas-api .
docker build -f apps/web/Dockerfile -t sistema-reservas-web .
```

### Habilitar el envío de email en local

El stack arranca con `NOTIFICATION_CHANNEL=log` (LogChannel), que **no requiere**
`RESEND_API_KEY`: registra en el log el email que se habría enviado. Para usar
email real, agregar al servicio `api` de `docker-compose.yml`:

```yaml
environment:
  NOTIFICATION_CHANNEL: email
  RESEND_API_KEY: re_xxxxxxxx
  RESEND_FROM: no-reply@tudominio.com
```

> Importante: **no** definir `RESEND_API_KEY`/`RESEND_FROM` vacíos. El
> `EmailChannel` se construye solo cuando ambas están presentes y no vacías;
> con cadenas vacías el `api` falla al arrancar.

---

## 7. Healthchecks

| Servicio | Chequeo |
|---|---|
| `db` / `db-test` | `pg_isready` |
| `api` | `GET /api/v1/health` (200 con BD arriba) |
| `web` | `GET /` (200) |

El `api` declara `depends_on: migrate: service_completed_successfully`; el `web`
espera a que el `api` esté `healthy`.
