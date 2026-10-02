# Sistema de Reservas — Microproducto de arranque

> **Estado**: ⚪ Planificado · **Fase**: 1 (arranque) · **Duración**: 1–2 semanas
> Referencia: `docs/plan-ataque-temporada-2.md` → sección 4

## Qué es

Microproducto que valida el **flujo Product Engineer completo en pequeño**: descubrir el problema, definir requisitos, modelar el dominio, diseñar, construir, medir y publicar. Es el primer ciclo de la temporada, antes de invertir en el producto insignia.

## Problema

Los negocios y profesionales que reciben citas por WhatsApp/teléfono pierden control de su disponibilidad, sufren no-shows y olvidan recordatorios.

## Alcance v1

- Agenda de disponibilidad del negocio (horarios, bloques)
- Reserva con datos de contacto (cliente, servicio, fecha/hora)
- Confirmación y recordatorio (mínimo: email o enlace de confirmación)
- Cancelación / reagendulación con estado del turno
- Vista simple para el negocio (turnos del día, historial)

**Fuera de alcance (v1)**: pagos, multi-sucursal, panel analítico completo, app móvil.

## Capacidades del mapa que ejercita

Problem Discovery · Requirements Engineering · Domain Modeling · Product Architecture · Product Analytics · Experimentation · Reliability + Security by Design · AI-Augmented Engineering (≈8 de 16)

## Métricas

Reservas creadas/semana · Tasa de no-show · Ocupación de agenda · Cancelaciones — medidas desde el día 1 (eventos de negocio, no solo logs).

## Por qué este proyecto (criterios clave)

- **¿Qué podré hacer después que hoy no puedo?** Ejecutar el ciclo completo Product Engineer de punta a punta con evidencia.
- **¿Qué parte es transferible?** El patrón dominio → reserva → recordatorio → medición aplica a servicios, talleres, clínicas y consultorios.
- **¿Qué parte requiere criterio humano?** El diseño del flujo de reserva y las decisiones de priorización.

## Artefactos derivados (1 fenómeno → varios)

1. Producto (este folder)
2. Ficha técnica (requisitos + dominio + métricas + priorización)
3. Auditoría de IA respondida
4. Artículo #1: "Cómo convertí un problema de negocio en un producto" → `contenido/`

## Criterio de "hecho" (nivel Profesional)

GitHub + README + demo desplegada + arquitectura + screenshots + changelog + OpenAPI + tests + Docker + ficha con requisitos/dominio/métricas + auditoría IA.

## Stack

Node/TypeScript + PostgreSQL + React (patrón T1) + Docker · deploy: a decidir en Fase 0 (Vercel/Railway).