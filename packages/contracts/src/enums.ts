/**
 * Enums compartidos del Sistema de Reservas.
 *
 * Patrón const types (REQUERIDO por las convenciones del proyecto):
 *   const X = { ... } as const;
 *   type T = (typeof X)[keyof typeof X];
 *
 * NUNCA usar union literals directas (`type T = "a" | "b"`).
 *
 * Los valores (snake_case, español) son el espejo exacto de:
 *  - los enums PostgreSQL de la migración 1 (T-05), y
 *  - los enums del contrato OpenAPI 3.1 (openapi.yaml).
 */

/** Estado del turno (enum Postgres `turno_estado`). */
export const TurnoEstado = {
  Pendiente: "pendiente",
  Confirmado: "confirmado",
  Completado: "completado",
  Cancelado: "cancelado",
  NoShow: "no_show",
} as const;
export type TurnoEstado = (typeof TurnoEstado)[keyof typeof TurnoEstado];

/** Canal de recordatorio (enum Postgres `recordatorio_canal`). */
export const RecordatorioCanal = {
  Email: "email",
  Log: "log",
} as const;
export type RecordatorioCanal =
  (typeof RecordatorioCanal)[keyof typeof RecordatorioCanal];

/** Estado del recordatorio (enum Postgres `recordatorio_estado`). */
export const RecordatorioEstado = {
  Programado: "programado",
  Enviado: "enviado",
  Fallido: "fallido",
  Cancelado: "cancelado",
} as const;
export type RecordatorioEstado =
  (typeof RecordatorioEstado)[keyof typeof RecordatorioEstado];

/** Tipo de evento de métricas (enum Postgres `evento_tipo`). */
export const EventoTipo = {
  ReservaCreada: "reserva_creada",
  ReservaConfirmada: "reserva_confirmada",
  Cancelacion: "cancelacion",
  Reagendulacion: "reagendulacion",
  RecordatorioEnviado: "recordatorio_enviado",
  RecordatorioFallido: "recordatorio_fallido",
  Completado: "completado",
  NoShow: "no_show",
} as const;
export type EventoTipo = (typeof EventoTipo)[keyof typeof EventoTipo];

/** Origen del evento (enum Postgres `evento_origen`). */
export const EventoOrigen = {
  Public: "public",
  Business: "business",
  System: "system",
} as const;
export type EventoOrigen = (typeof EventoOrigen)[keyof typeof EventoOrigen];

/**
 * Estados activos del turno (los que ocupan slot y participan del claim
 * atómico). Útil para queries con `estado IN (...)`.
 */
export const TurnoEstadosActivos = [
  TurnoEstado.Pendiente,
  TurnoEstado.Confirmado,
] as const satisfies readonly TurnoEstado[];
export type TurnoEstadoActivo = (typeof TurnoEstadosActivos)[number];