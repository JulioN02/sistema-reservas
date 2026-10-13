# Privacidad y retención de datos — Sistema de Reservas

Documento de evidencia del producto para los requisitos transversales de
privacidad **PRV-01 a PRV-04** (spec §10, RNF-04). Aplica a la v1 del Sistema de
Reservas y a los datos personales que maneja: **nombre, email y teléfono** del
cliente final.

> **Principio rector**: minimización de datos. El sistema recoge solo lo necesario
> para prestar el servicio (identificar al cliente y contactarlo por su turno) y
> evita la PII en todo lo que no la necesita (eventos de métricas y enlaces
> públicos).

---

## 1. Qué datos se guardan y dónde

| Dato | Tabla / ubicación | Se expone en |
|---|---|---|
| Nombre del cliente | `clientes.nombre` | enlace de gestión (al propio cliente) |
| Email del cliente | `clientes.email` | envío de recordatorio (canal `email`) |
| Teléfono del cliente | `clientes.telefono` | envío de recordatorio (canal `log`/demo) |
| Canal y consentimiento | `clientes.consentimiento`, `clientes.consentido_en` | — |
| Turnos | `turnos` | enlace de gestión, panel del negocio |
| Eventos de negocio | `eventos_metricas` | métricas agregadas |

Todos los registros de negocio llevan `tenant_id`: los datos se resuelven y
mutan siempre dentro del tenant del operador o del enlace (aislamiento — RB-INT-01).

---

## PRV-01 — Consentimiento explícito

- Al crear un cliente (reserva del cliente o reserva del negocio en su nombre) el
  **consentimiento es obligatorio**: `consentimiento: true` es requisito de la
  petición.
- Si falta o es `false`, la API responde **422** (`application/problem+json`) con
  el campo `consentimiento` en `errores[]`, y **no persiste nada** (ni cliente, ni
  turno).
- La aceptación se registra con fecha en `clientes.consentimiento` y
  `clientes.consentido_en`.

**Evidencia**: `apps/api/src/tests/reserva.test.ts` (caso
`PRV-01/CA-RST-03: consentimiento false → 422`).

---

## PRV-02 — Derecho de baja (anonimización)

A pedido del negocio, el sistema **anonimiza la PII de un cliente** mediante
`privacyService.anonimizarCliente(db, tenantId, clienteId)`
(`apps/api/src/services/privacyService.ts`).

Efecto exacto de la operación sobre la fila de `clientes`:

| Campo | Antes | Después |
|---|---|---|
| `nombre` | dato real | `"[eliminado]"` |
| `email` | dato real | `NULL` |
| `telefono` | dato real | `"[eliminado]"` |
| `updated_at` | — | `now()` |

Lo que **se conserva** (retención sin PII):

- El `id` del cliente y su relación con los turnos (`turnos.cliente_id`).
- Los **turnos** (fechas, servicio, estado).
- Los **eventos de métricas** asociados.

> **Nota sobre el canal de contacto**: el esquema exige al menos un canal no
> nulo (`CHECK clientes_canal_check`: email **o** teléfono). Por eso el email se
> vacía a `NULL` y el teléfono se sustituye por la marca `"[eliminado]"`: así el
> constraint se mantiene satisfecho sin conservar PII real. El resultado es PII
> irrecuperable sin romper la integridad referencial.

**Alcance**: la operación está **limitada al tenant** — no anonimiza clientes de
otro negocio (aislamiento, INT-S1). La anonimización es **irreversible** (R-D7);
por eso este documento define la política de retención (§ PRV-04).

**Evidencia**: `apps/api/src/tests/privacy.test.ts` (anonimización conserva ids,
turnos y eventos; scoped por tenant).

---

## PRV-03 — Minimización

- El formulario y el DTO aceptan **nombre + al menos un canal** (email y/o
  teléfono); no se piden más datos personales.
- El email se **normaliza** (lowercase) y se deduplica de forma *soft* por
  tenant, sin convertirse en una llave que bloquee el flujo.
- Los **enlaces públicos** de gestión (`/turnos/{token}`, `/g/{token}`) operan
  sobre el turno derivado del token y **no exponen datos de terceros**.

---

## Sin PII en eventos de negocio

Los eventos de `eventos_metricas` (RF-21) **nunca contienen datos personales**.
Sus payloads usan únicamente el `turno_id` como correlación y campos de dominio
no personales (por ejemplo `canal_contacto: "email" | "telefono"`,
`origen`, `creado_por`, `dentro_gracia`).

**Evidencia**: tests de métricas (CA-MTE-03: auditoría sin PII en eventos).

---

## PRV-04 — Política de retención

| Dato | Retención |
|---|---|
| Datos personales del cliente (`nombre`, `email`, `telefono`) | Mientras el cliente tenga relación activa con el negocio; **anonimizables bajo demanda** (PRV-02). |
| Turnos (fecha, servicio, estado) | **Se conservan** para el negocio (historial y trazabilidad), ya sin PII si el cliente fue anonimizado. |
| Eventos de métricas | **Se conservan** de forma indefinida y agregada; no contienen PII. |
| Sesiones del operador | Se revocan al hacer logout; expiran por TTL (`SESSION_TTL_DAYS`, default 7 días). |
| Enlaces de gestión (token) | Expiran al alcanzar un estado terminal o a los 7 días posteriores a la cita. |

**Base de la política**: los turnos y eventos son el insumo del negocio
(operación y métricas) y no aportan valor personal una vez anonimizado el
cliente; los datos personales, en cambio, se conservan solo mientras son
necesarios para prestar el servicio y pueden eliminarse a pedido.

---

## 3. Seguridad de los datos

- **En tránsito**: HTTPS y cookies de sesión `Secure` en producción
  (`COOKIE_SECURE=true`).
- **Sesión**: token opaco; se guarda solo su hash (`sha256`) en `sesiones`.
- **Enlaces**: tokens aleatorios no enumerables (≥ 128 bits); la respuesta a un
  token inválido o expirado es genérica y no revela datos (CMR-S3).
- **Consultas parametrizadas** (cero interpolación de SQL).
- **CORS** al origen exacto de la SPA; **CSRF** mitigado con `SameSite=Lax` +
  verificación de `Content-Type` en mutaciones JSON.
- **Errores** `problem+json` sin detalle interno; 500 genérico con `request_id`.
- **Logs** estructurados sin datos personales en claro.

---

## 4. Implementación y verificación

| Requisito | Dónde vive | Test |
|---|---|---|
| PRV-01 consentimiento | `dto/turnos`, `services/turnoService` | `reserva.test.ts` |
| PRV-02 anonimización | `services/privacyService` → `repositories/turnoRepository` | `privacy.test.ts` |
| PRV-03 minimización | DTOs de reserva, enlace de gestión | `reserva.test.ts`, `confirmacion.test.ts` |
| Sin PII en eventos | `services/eventoService`, `services/metricasService` | `metricas.test.ts` |
| PRV-04 retención | este documento | — |
