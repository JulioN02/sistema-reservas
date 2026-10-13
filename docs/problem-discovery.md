# Problem Discovery — Sistema de Reservas (ficha técnica)

Evidencia del ciclo **Product Engineer** para el microproducto Sistema de
Reservas: problema y contexto, requisitos, dominio, métricas y priorización.
Este documento es la **ficha técnica** derivada del producto (el primer
artefacto pedido por el criterio de "hecho" de nivel Profesional).

> Fuentes internas: informe de exploración fundacional y propuesta del cambio
> `fundacion-producto` (memoria del proyecto `sistema-reservas`).

---

## 1. Problema y contexto

**Dolor real**: los negocios y profesionales que reciben citas por WhatsApp o
teléfono gestionan su agenda de forma manual (papel, memoria, chat). Consecuencias:

- **Pérdida de control de la disponibilidad**: sin una vista única de
  horarios libres/ocupados → sobre-reservas accidentales y huecos que nadie
  detecta.
- **No-shows**: el cliente olvida el turno porque nadie se lo recuerda.
- **Recordatorios olvidados**: no hay capacidad sistemática; cuando ocurre, es
  manual y frágil.
- **Fricción operativa**: idas y vueltas por chat/teléfono para reservar,
  confirmar, cancelar o reagendar.
- **Sin trazabilidad**: no hay registro de qué se confirmó, canceló o no se
  presentó → imposible medir y mejorar.

**Por qué vale la pena resolverlo**: es un dolor frecuente, transversal y
directamente medible (tasa de no-show, ocupación); el valor para el negocio es
inmediato (recuperar capacidad, reducir ausencias) y el patrón
`dominio → reserva → recordatorio → medición` es transferible a servicios,
talleres, clínicas y consultorios.

**Qué valida este proyecto**: el ciclo completo de Product Engineer en
pequeño — descubrir, definir requisitos, modelar el dominio, diseñar, construir,
medir y publicar — antes de invertir en el producto insignia de la temporada.

**A quién afecta** (segmentos): clínicas y consultorios; talleres y servicios;
servicios personales (salones, barberías, estética); profesionales
independientes (clases, asesorías, coaching, fotografía).

---

## 2. Alcance v1

### Funcional (RF-01..RF-22), por módulo

- **Agenda de disponibilidad** — horarios recurrentes por día con zona horaria
  (RF-01); bloques de indisponibilidad puntuales (RF-02); cálculo de slots =
  horarios − bloques − turnos (RF-03); configuración de servicios y duración
  (RF-04).
- **Reserva** — reserva del cliente entre slots disponibles con nombre + email
  y/o teléfono (RF-05); estado inicial pendiente + asociación
  cliente/servicio/fecha-hora (RF-06); protección de doble reserva ante
  concurrencia (RF-07); reserva en nombre del cliente (RF-08).
- **Confirmación y recordatorio** — confirmación por enlace y/o email (RF-09);
  confirmación con un toque registrada como evento (RF-10); recordatorio
  programado antes del turno (RF-11); ciclo de estados (RF-12).
- **Cancelación y reagendación** — cancelación del cliente dentro de la gracia
  (RF-13); reagendación (RF-14); acciones del negocio con motivo (RF-15);
  notificación al afectado (RF-16).
- **Vista del negocio** — vista del día cronológica (RF-17); historial
  filtrable (RF-18); acciones: confirmar, cancelar, completado, no-show (RF-19);
  auth simple separada del flujo público (RF-20).
- **Métricas desde el día 1** — eventos de negocio persistidos (RF-21); vista
  mínima de 4 KPIs (RF-22).

### Decisiones de modelado (gate)

1. **Multi-tenant por diseño, un tenant activo en v1**: `tenant_id` en todas las
   tablas + aislamiento testeado; sin gestión de tenants ni billing.
2. **Una agenda por negocio**: 1 slot = 1 turno (sin capacidad paralela).
   Multi-profesional es extensión futura.
3. **Recordatorio = email + enlace de confirmación**: capa de notificaciones
   abstraída (`EmailChannel` funcional, `LogChannel` en dev/demo,
   `WhatsAppChannel` futuro). El enlace funciona aunque el email falle.
4. **Parámetros por servicio**: `booking_window_days` y
   `cancellation_grace_minutes` editables desde el panel.

### Fuera de alcance v1 (explícito)

Pagos y señas · multi-sucursal · multi-profesional · panel analítico completo ·
app móvil nativa · recordatorios por WhatsApp/SMS (solo el *seam* de canal) ·
gestión de tenants/registro/billing · lista de espera · CRM de clientes ·
integración con calendarios externos · multi-idioma.

### No funcionales (RNF-01..RNF-10)

Rendimiento (agenda/vista día < 300 ms p95; reserva < 500 ms p95) ·
disponibilidad ≥ 99 % con cola y reintentos de recordatorios · seguridad (DTO
como fuente de verdad, HTTPS, tokens no enumerables, rate limiting, aislamiento
multi-tenant) · privacidad (minimización, consentimiento, derecho de baja,
retención — ver [`privacidad.md`](privacidad.md)) · usabilidad (reserva ≤ 3
pasos, español neutro) · accesibilidad base WCAG AA · observabilidad (logging
estructurado, eventos correlacionados) · mantenibilidad (API-first `/api/v1`,
OpenAPI, migraciones versionadas, config por entorno, TDD) · portabilidad
(Docker, PostgreSQL) · zonas horarias (UTC + zona del negocio, DST).

---

## 3. Modelo de dominio

| Entidad | Rol | Invariantes clave |
|---|---|---|
| **Cliente** | quien reserva | ≥ 1 canal (email o teléfono); email normalizado; dedup *soft* |
| **Servicio** | qué se reserva | `duracion_min` múltiplo de 15; `booking_window_days` 1–90; gracia 30–1440 |
| **Disponibilidad** | cuándo | `HorarioRecurrente` (inicio < fin, sin solape), `BloqueIndisponibilidad` (no pisa turnos activos), `Slot` (proyección, no tabla) |
| **Turno** | la reserva | `fin > inicio`; un turno por slot; ciclo de estados con finales sin transiciones |
| **Recordatorio** | contacto previo | se resuelve a `enviado`/`fallido` en ≤ 3 intentos |

Soporte multi-tenant: `tenants`, `operadores`, `sesiones`; instrumentación:
`eventos_metricas`.

**Ciclo de vida del turno**: `pendiente → confirmado → completado | cancelado |
no-show` (estados terminales sin transiciones).

---

## 4. Métricas del producto

Medidas desde el día 1 a partir de **eventos de negocio persistidos** (no logs).
Vista mínima vía `GET /api/v1/metricas/resumen`:

| # | KPI | Ventana | Cálculo |
|---|---|---|---|
| 1 | Reservas creadas | 8 semanas ISO | eventos `reserva_creada` por semana |
| 2 | Tasa de no-show | 4 semanas | `no_show` ÷ (`completado` + `no_show`) |
| 3 | Ocupación de agenda | semana actual | turnos activos ÷ slots ofrecidos |
| 4 | Cancelaciones | 4 semanas | cantidad + tasa (cancelados ÷ creados) |

Los KPIs se validan contra un fixture de datos sintéticos deterministas
(± 0,1 pp) y devuelven `null` cuando no hay datos suficientes.

**Hipótesis de valor**: recordatorios + confirmación activa reducen el no-show;
la instrumentación permite comprobarlo con datos, no con intuición.

---

## 5. Priorización

Criterio de priorización **RICE** aplicado a las capacidades de v1 (impacto en
el dolor → confianza → esfuerzo). Orden de construcción por vertical slices:

| Orden | Capacidad | Por qué primero |
|---|---|---|
| 1 | Agenda + reserva | núcleo del valor; habilita todo lo demás |
| 2 | Confirmación + recordatorio | ataca directamente el no-show |
| 3 | Cancelación / reagendación | recupera capacidad; cierra el ciclo del turno |
| 4 | Vista del negocio | hace usable el producto para el operador |
| 5 | Métricas | convierte el producto en medible y mejorable |

Regla de mitigación (**R4 — alcance/tiempo**): vertical slices estrictas y
recorte de lo que no rompe el criterio de "hecho".

---

## 6. Evidencia de Problem Discovery (A5)

> **Declaración explícita de ausencia (R-D9).**
>
> El plan original exige, como Problem Discovery, **entrevistas u observación a
> 1–2 negocios reales**. A la fecha de la v1 **no existe evidencia documentada
> de esas entrevistas en el repositorio**.

Consecuencias y postura:

- El problema, los segmentos y los requisitos de la v1 se derivaron del
  **análisis de dominio** y del dolor conocido del negocio (exploración
  fundacional), **no** de entrevistas de campo documentadas.
- Ningún requisito de la especificación **depende** de esa evidencia: la
  validación con negocios reales queda como **trabajo pendiente posterior al
  cierre** (fuera de la v1 técnica).
- Registrado como riesgo **A5** (severidad media) y diferido a la fase de
  archivo como tarea de documentación (ficha + artículo, o esta declaración de
  ausencia).

**Riesgo asociado**: construir requisitos sobre supuestos de dominio en lugar de
observación de campo. **Mitigación**: datos sintéticos + instrumentación desde
el día 1 para generar señal medible apenas exista uso real.

---

## 7. Artículo #1 — estado: pendiente

> **Declaración de ausencia.**
>
> El artefacto derivado **Artículo #1: "Cómo convertí un problema de negocio en
> un producto"** está **pendiente y no fue redactado** en este ciclo. Se declara
> su ausencia de forma explícita en lugar de presentarlo como completado.

El material para redactarlo queda disponible en este documento y en el
[README](../README.md): el recorrido problema → requisitos → dominio → diseño →
construcción → métricas, con las decisiones y las compensaciones tomadas.

---

## 8. Riesgos y supuestos

| # | Riesgo / supuesto | Sev. | Estado |
|---|---|---|---|
| A5 | Evidencia de Problem Discovery ausente | Media | **Declarado** (este doc, §6) |
| R1 | Sobre-diseño del dominio de agenda | Alta | Mitigado: slots discretos en v1 |
| R2 | Métricas vacías sin uso real | Media | Mitigado: seed sintético + instrumentación |
| R3 | Entregabilidad de email | Media | Mitigado: proveedor transaccional + enlace como fallback |
| R4 | Alcance/tiempo | Media | Mitigado: vertical slices + priorización RICE |
| R5 | Concurrencia (doble reserva) | Media | Mitigado: constraint BD + 409 con alternativas |
| R6 | Datos personales y normativa | Media | Mitigado: ver [`privacidad.md`](privacidad.md) |
