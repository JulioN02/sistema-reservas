import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  EventoOrigen,
  EventoTipo,
  RecordatorioCanal,
  RecordatorioEstado,
  TurnoEstado,
} from "@sistema-reservas/contracts";

/**
 * Esquema multi-tenant de la migración 1 (diseño §3.1, spec INT-01).
 *
 * Convenciones:
 * - TODAS las tablas de negocio llevan `tenant_id` REFERENCES tenants(id)
 *   (CA-INT-02).
 * - Identificadores de dominio en español (AD-07); nombres técnicos en inglés.
 * - Enums PostgreSQL explícitos, nunca strings libres (spec §3.2). Los valores
 *   provienen de packages/contracts (fuente única, patrón const types).
 * - CHECKs como red final de validación (RNF-03); zod es la fuente de verdad
 *   de runtime.
 */

export const turnoEstado = pgEnum("turno_estado", [
  TurnoEstado.Pendiente,
  TurnoEstado.Confirmado,
  TurnoEstado.Completado,
  TurnoEstado.Cancelado,
  TurnoEstado.NoShow,
] as const);

export const recordatorioCanal = pgEnum("recordatorio_canal", [
  RecordatorioCanal.Email,
  RecordatorioCanal.Log,
] as const);

export const recordatorioEstado = pgEnum("recordatorio_estado", [
  RecordatorioEstado.Programado,
  RecordatorioEstado.Enviado,
  RecordatorioEstado.Fallido,
  RecordatorioEstado.Cancelado,
] as const);

export const eventoTipo = pgEnum("evento_tipo", [
  EventoTipo.ReservaCreada,
  EventoTipo.ReservaConfirmada,
  EventoTipo.Cancelacion,
  EventoTipo.Reagendulacion,
  EventoTipo.RecordatorioEnviado,
  EventoTipo.RecordatorioFallido,
  EventoTipo.Completado,
  EventoTipo.NoShow,
] as const);

export const eventoOrigen = pgEnum("evento_origen", [
  EventoOrigen.Public,
  EventoOrigen.Business,
  EventoOrigen.System,
] as const);

/** Tenants (negocios). Slug único; v1: un solo tenant activo (demo). */
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  nombre: text("nombre").notNull(),
  /** Zona horaria IANA (p. ej. America/Argentina/Buenos_Aires) — AD-06. */
  timezone: text("timezone").notNull(),
  /** Alimentan el mensaje 403 fuera de gracia (RB-CRG-02). */
  email_contacto: text("email_contacto"),
  telefono_contacto: text("telefono_contacto"),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Operadores del negocio (v1: uno por tenant — RB-VNG-06). */
export const operadores = pgTable(
  "operadores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** Email normalizado (lowercase). */
    email: text("email").notNull(),
    /** Hash argon2id del password (A8). */
    password_hash: text("password_hash").notNull(),
    nombre: text("nombre").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("operadores_tenant_email_uq").on(t.tenant_id, t.email)],
);

/** Sesiones opacas del operador: la BD solo guarda el sha256 del token. */
export const sesiones = pgTable("sesiones", {
  id: uuid("id").primaryKey().defaultRandom(),
  operador_id: uuid("operador_id")
    .notNull()
    .references(() => operadores.id),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  token_hash: text("token_hash").notNull().unique(),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  revoked_at: timestamp("revoked_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Clientes: deduplicación soft por email/teléfono (EC-16). */
export const clientes = pgTable(
  "clientes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    nombre: text("nombre").notNull(),
    email: text("email"),
    telefono: text("telefono"),
    /** Consentimiento obligatorio (PRV-01); se registra la fecha. */
    consentimiento: boolean("consentimiento").notNull(),
    consentido_en: timestamp("consentido_en", { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Índice único parcial: un email por tenant; permite múltiples NULL.
    uniqueIndex("clientes_tenant_email_uq")
      .on(sql`lower(${t.email})`)
      .where(sql`${t.email} IS NOT NULL`),
    // Red final: al menos un canal de contacto (CA-RST-03).
    check("clientes_canal_check", sql`${t.email} IS NOT NULL OR ${t.telefono} IS NOT NULL`),
  ],
);

/** Servicios ofrecidos por el negocio (AGD-04). */
export const servicios = pgTable(
  "servicios",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    nombre: text("nombre").notNull(),
    /** Duración en minutos; múltiplo de 15 (RB-AGD-01). */
    duracion_min: integer("duracion_min").notNull(),
    /** Precio informativo (opcional). */
    precio: numeric("precio", { precision: 10, scale: 2 }),
    /** Ventana de reserva [hoy, hoy + booking_window_days) (RB-AGD-02). */
    booking_window_days: integer("booking_window_days").notNull().default(30),
    /** Gracia de cancelación del cliente en minutos (RB-CRG-01). */
    cancellation_grace_minutes: integer("cancellation_grace_minutes")
      .notNull()
      .default(180),
    activo: boolean("activo").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "servicios_duracion_check",
      sql`${t.duracion_min} > 0 AND ${t.duracion_min} % 15 = 0`,
    ),
    check(
      "servicios_booking_window_check",
      sql`${t.booking_window_days} BETWEEN 1 AND 90`,
    ),
    check(
      "servicios_gracia_check",
      sql`${t.cancellation_grace_minutes} BETWEEN 30 AND 1440`,
    ),
  ],
);

/** Horarios recurrentes (hora local de pared + timezone; DST vía date-fns-tz). */
export const horariosRecurrentes = pgTable(
  "horarios_recurrentes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** Día de la semana 1–7 (1 = lunes). */
    dia_semana: integer("dia_semana").notNull(),
    hora_inicio: time("hora_inicio").notNull(),
    hora_fin: time("hora_fin").notNull(),
    /** Zona horaria del horario (puede diferir de la del tenant). */
    timezone: text("timezone").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("horarios_dia_check", sql`${t.dia_semana} BETWEEN 1 AND 7`),
    check("horarios_inicio_fin_check", sql`${t.hora_inicio} < ${t.hora_fin}`),
  ],
);

/** Bloques de indisponibilidad puntuales (AGD-02). */
export const bloquesIndisponibilidad = pgTable(
  "bloques_indisponibilidad",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    fecha_inicio: timestamp("fecha_inicio", { withTimezone: true }).notNull(),
    fecha_fin: timestamp("fecha_fin", { withTimezone: true }).notNull(),
    motivo: text("motivo"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("bloques_fechas_check", sql`${t.fecha_fin} >= ${t.fecha_inicio}`),
  ],
);

/**
 * Turnos (reservas). El slot es proyección calculada, NO tabla (RB-AGD-07);
 * el índice único parcial es la red final del claim atómico (diseño §5).
 */
export const turnos = pgTable(
  "turnos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    cliente_id: uuid("cliente_id")
      .notNull()
      .references(() => clientes.id),
    servicio_id: uuid("servicio_id")
      .notNull()
      .references(() => servicios.id),
    /** sha256 del token de gestión (32 bytes base64url) — RB-CMR-01. */
    token_hash: text("token_hash").notNull().unique(),
    fecha_hora_inicio: timestamp("fecha_hora_inicio", {
      withTimezone: true,
    }).notNull(),
    fecha_hora_fin: timestamp("fecha_hora_fin", { withTimezone: true }).notNull(),
    estado: turnoEstado("estado").notNull().default(TurnoEstado.Pendiente),
    /** Motivo de cancelación/reagendamiento (negocio). */
    motivo: text("motivo"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Red final del claim atómico: dos turnos activos nunca comparten inicio.
    uniqueIndex("turnos_tenant_inicio_activo_uq")
      .on(t.tenant_id, t.fecha_hora_inicio)
      .where(sql`${t.estado} IN ('pendiente', 'confirmado')`),
    // Hot paths: agenda/vista día e historial filtrado (VNG-02).
    index("turnos_tenant_inicio_idx").on(t.tenant_id, t.fecha_hora_inicio),
    index("turnos_tenant_estado_inicio_idx").on(
      t.tenant_id,
      t.estado,
      t.fecha_hora_inicio,
    ),
    check("turnos_horario_check", sql`${t.fecha_hora_fin} > ${t.fecha_hora_inicio}`),
  ],
);

/**
 * Recordatorios: la propia tabla es la cola (sin Redis, YAGNI); el índice
 * parcial alimenta el sweep con SKIP LOCKED (diseño §6.2).
 */
export const recordatorios = pgTable(
  "recordatorios",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    turno_id: uuid("turno_id")
      .notNull()
      .references(() => turnos.id),
    canal: recordatorioCanal("canal").notNull(),
    programado_para: timestamp("programado_para", {
      withTimezone: true,
    }).notNull(),
    estado: recordatorioEstado("estado")
      .notNull()
      .default(RecordatorioEstado.Programado),
    intentos: integer("intentos").notNull().default(0),
    ultimo_error: text("ultimo_error"),
    enviado_en: timestamp("enviado_en", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("recordatorios_programados_idx")
      .on(t.estado, t.programado_para)
      .where(sql`${t.estado} = 'programado'`),
  ],
);

/**
 * Eventos de métricas: append-only, evento_id PK para idempotencia
 * (RB-MTE-01). Sin PII (RB-MTE-04).
 */
export const eventosMetricas = pgTable(
  "eventos_metricas",
  {
    evento_id: uuid("evento_id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    turno_id: uuid("turno_id")
      .notNull()
      .references(() => turnos.id),
    cliente_id: uuid("cliente_id"),
    servicio_id: uuid("servicio_id"),
    tipo: eventoTipo("tipo").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    origen: eventoOrigen("origen").notNull(),
    timestamp_utc: timestamp("timestamp_utc", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("eventos_tenant_timestamp_idx").on(t.tenant_id, t.timestamp_utc),
    index("eventos_tenant_tipo_timestamp_idx").on(
      t.tenant_id,
      t.tipo,
      t.timestamp_utc,
    ),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type Operador = typeof operadores.$inferSelect;
export type Sesion = typeof sesiones.$inferSelect;
export type Cliente = typeof clientes.$inferSelect;
export type Servicio = typeof servicios.$inferSelect;
export type HorarioRecurrente = typeof horariosRecurrentes.$inferSelect;
export type BloqueIndisponibilidad = typeof bloquesIndisponibilidad.$inferSelect;
export type Turno = typeof turnos.$inferSelect;
export type Recordatorio = typeof recordatorios.$inferSelect;
export type EventoMetrica = typeof eventosMetricas.$inferSelect;