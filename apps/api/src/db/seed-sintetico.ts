import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { addDays, format, parseISO, startOfISOWeek } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { eq } from "drizzle-orm";
import {
  EventoOrigen,
  EventoTipo,
  RecordatorioCanal,
  RecordatorioEstado,
  TurnoEstado,
} from "@sistema-reservas/contracts";
import { parseEnv } from "../config/env";
import { createDb, type Database } from "./index";
import { seedDatabase } from "./seed";
import {
  clientes as clientesTable,
  eventosMetricas,
  recordatorios as recordatoriosTable,
  turnos as turnosTable,
} from "./schema";
import { calcularSlots } from "../services/agendaService";
import { finSemanaISO, inicioSemanaISO } from "../services/metricasService";

/**
 * Seed sintético determinista + fixture de KPIs (T-22, A7, diseño §7.3).
 *
 * Genera 8 semanas de datos CONSISTENTES en la zona del negocio (más las dos
 * semanas futuras dentro de la ventana de reserva) y, por cada turno, la
 * cadena completa de eventos de métricas: `reserva_creada` → `reserva_confirmada`
 * → `completado`/`no_show` (o `cancelacion`), más `recordatorio_enviado`/
 * `recordatorio_fallido` y las filas de la cola de `recordatorios`.
 *
 * Determinismo: PRNG **mulberry32** con semilla fija (`SEMILLA_SINTETICA`).
 * Misma semilla + misma ancla ⇒ exactamente el mismo dataset y los mismos KPIs.
 *
 * Estabilidad de KPIs entre fechas: el dataset se ancla al lunes de la semana
 * ISO actual (`M0`) y los eventos de creación (`reserva_creada`) se colocan en
 * el lunes 00:00 local de su semana. Las semanas 1–3 y 5–7 quedan siempre
 * dentro/fuera de la ventana rodante de 28 días (con margen), y la semana 4
 * solo aloja turnos NO terminales, de modo que los 4 KPIs son invariantes de
 * fecha (salvo la etiqueta ISO, que el test no compara).
 *
 * Cálculo del fixture (independiente de `metricasService`, documentado):
 *   - KPI1: reservas_creada agrupadas por semana ISO (zona negocio), desc, top 8.
 *   - KPI2: no_show ÷ (completado + no_show) sobre turnos con inicio < ancla y
 *     ≥ ancla − 28d (denominador 0 → null).
 *   - KPI3: turnos de la semana actual (pendiente/confirmado/completado) ÷
 *     capacidad ofrecida (Σ slots por servicio activo vía `calcularSlots`).
 *   - KPI4: eventos `cancelacion` ÷ `reserva_creada` con ts ∈ [ancla−28d, ancla].
 */

/** Ancla fija del dataset/fixture (miércoles 12:00 ART). */
export const ANCLA_SINTETICA = new Date("2026-10-07T15:00:00.000Z");
/** Semilla fija del PRNG mulberry32. */
export const SEMILLA_SINTETICA = 20261007;
/** Clientes sintéticos (pool reutilizado por los turnos). */
const CLIENTES_SINTETICOS = 24;
/** Semanas pasadas/actuales del dataset (0 = semana ISO actual). */
const SEMANAS_HISTORIA = [1, 2, 3, 4, 5, 6, 7] as const;
/** Semanas futuras (dentro de la ventana de reserva del seed). */
const SEMANAS_FUTURAS = [-2, -1] as const;
const DIAS_SEMANA = [0, 1, 2, 3, 4, 5] as const;
const HORAS_ENTRESEMANA = [
  "09:00",
  "09:30",
  "10:00",
  "10:30",
  "11:00",
  "11:30",
  "12:00",
  "12:30",
  "14:00",
  "14:30",
  "15:00",
  "15:30",
  "16:00",
  "16:30",
  "17:00",
] as const;
const HORAS_SABADO = [
  "09:00",
  "09:30",
  "10:00",
  "10:30",
  "11:00",
  "11:30",
  "12:00",
] as const;
const MS_DIA = 86_400_000;
const MS_MIN = 60_000;

/** Contrato de los 4 KPIs esperados (espejo de MetricasResumen, spec A9). */
export interface KpisEsperados {
  reservas_por_semana: Array<{ semana: string; cantidad: number }>;
  tasa_no_show: number | null;
  ocupacion_semana: number | null;
  cancelaciones: { cantidad: number; tasa: number };
}

export interface SeedSinteticoOpciones {
  /** Instante de referencia (default `new Date()`). */
  ahora?: Date;
  /** Semilla del PRNG (default `SEMILLA_SINTETICA`). */
  semilla?: number;
}

export interface SeedSinteticoResult {
  tenant_id: string;
  clientes: number;
  turnos: number;
  eventos: number;
  recordatorios: number;
  kpis: KpisEsperados;
}

/** PRNG mulberry32: 32 bits de estado, salida en [0, 1). Determinista. */
export function mulberry32(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface ServicioGen {
  id: string;
  duracion_min: number;
  cancellation_grace_minutes: number;
}
interface HorarioGen {
  dia_semana: number;
  hora_inicio: string;
  hora_fin: string;
  timezone: string;
}
interface ClienteGen {
  id: string;
  email: string | null;
  telefono: string | null;
}
interface Contexto {
  ahora: Date;
  timezone: string;
  tenantId: string;
  servicios: ServicioGen[];
  horarios: HorarioGen[];
  clientes: ClienteGen[];
  rng: () => number;
}

interface NuevoTurno {
  id: string;
  tenant_id: string;
  cliente_id: string;
  servicio_id: string;
  token_hash: string;
  fecha_hora_inicio: Date;
  fecha_hora_fin: Date;
  estado: TurnoEstado;
  motivo: string | null;
}
interface NuevoEvento {
  tenant_id: string;
  turno_id: string;
  cliente_id: string;
  servicio_id: string;
  tipo: EventoTipo;
  payload: Record<string, unknown>;
  origen: EventoOrigen;
  timestamp_utc: Date;
}
interface NuevoRecordatorio {
  tenant_id: string;
  turno_id: string;
  canal: RecordatorioCanal;
  programado_para: Date;
  estado: RecordatorioEstado;
  intentos: number;
  ultimo_error: string | null;
  enviado_en: Date | null;
}

/** Lunes 00:00 local (zona del negocio) de la semana ISO que contiene `ahora`. */
function lunesSemanaLocal(ahora: Date, timezone: string): string {
  const fecha = formatInTimeZone(ahora, timezone, "yyyy-MM-dd");
  return format(startOfISOWeek(parseISO(fecha)), "yyyy-MM-dd");
}

/** Fecha local `yyyy-MM-dd` a `desplazamiento` días de `base` (calendario). */
function fechaLocal(base: string, desplazamiento: number): string {
  return format(addDays(parseISO(base), desplazamiento), "yyyy-MM-dd");
}

/** Mezcla determinista (Fisher–Yates con el PRNG). */
function mezclar<T>(items: readonly T[], rng: () => number): T[] {
  const copia = [...items];
  for (let i = copia.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copia[i]!;
    copia[i] = copia[j]!;
    copia[j] = tmp;
  }
  return copia;
}

/** hash determinista del token de gestión (columna única, sin PII). */
function tokenHash(indice: number): string {
  return createHash("sha256").update(`sintetico-${indice}`).digest("hex");
}

/**
 * Estado del turno según su semana (w): futuro/actual y semana 4 → NO terminal
 * (mantiene estable la ventana de 28 días de KPI2); el resto mezcla terminales.
 */
function estadoDeSemana(w: number, rng: () => number): TurnoEstado {
  if (w <= 0 || w === 4) {
    return rng() < 0.55 ? TurnoEstado.Pendiente : TurnoEstado.Confirmado;
  }
  const r = rng();
  if (r < 0.5) return TurnoEstado.Completado;
  if (r < 0.65) return TurnoEstado.NoShow;
  if (r < 0.8) return TurnoEstado.Cancelado;
  return TurnoEstado.Pendiente;
}

/** Construye la cadena completa de eventos + recordatorios de un turno. */
function agregarCadena(
  ctx: Contexto,
  turno: NuevoTurno,
  creacion: Date,
  duracionMin: number,
  graciaMin: number,
  eventos: NuevoEvento[],
  recordatorios: NuevoRecordatorio[],
): void {
  const { tenantId, rng } = ctx;
  const base = {
    tenant_id: tenantId,
    turno_id: turno.id,
    cliente_id: turno.cliente_id,
    servicio_id: turno.servicio_id,
  };
  const inicio = turno.fecha_hora_inicio;
  const fin = turno.fecha_hora_fin;

  const canales = ["email", "telefono", "ambos"] as const;
  eventos.push({
    ...base,
    tipo: EventoTipo.ReservaCreada,
    payload: {
      slot_inicio_utc: inicio.toISOString(),
      slot_fin_utc: fin.toISOString(),
      canal_contacto: canales[Math.floor(rng() * canales.length)]!,
      creado_por: "cliente",
    },
    origen: EventoOrigen.Public,
    timestamp_utc: creacion,
  });

  const conConfirmacion =
    turno.estado === TurnoEstado.Confirmado ||
    turno.estado === TurnoEstado.Completado ||
    turno.estado === TurnoEstado.NoShow;
  if (conConfirmacion) {
    const medio = rng() < 0.7 ? "enlace" : "negocio";
    eventos.push({
      ...base,
      tipo: EventoTipo.ReservaConfirmada,
      payload: { medio },
      origen:
        medio === "enlace" ? EventoOrigen.Public : EventoOrigen.Business,
      timestamp_utc: new Date(creacion.getTime() + 2 * 3_600_000),
    });
  }

  if (turno.estado === TurnoEstado.Completado) {
    eventos.push({
      ...base,
      tipo: EventoTipo.Completado,
      payload: { minutos_desde_inicio: duracionMin },
      origen: EventoOrigen.Business,
      timestamp_utc: fin,
    });
  }

  if (turno.estado === TurnoEstado.NoShow) {
    eventos.push({
      ...base,
      tipo: EventoTipo.NoShow,
      payload: { minutos_post_inicio: 30 },
      origen: EventoOrigen.Business,
      timestamp_utc: new Date(inicio.getTime() + 30 * MS_MIN),
    });
  }

  if (turno.estado === TurnoEstado.Cancelado) {
    const dentroGracia = rng() < 0.6;
    // Se resta a lo sumo 180 min: el evento cae el mismo día (≥ 06:00), por lo
    // que permanece dentro de la semana del turno (ventana estable de KPI4).
    const restaMin = dentroGracia ? 60 : Math.min(graciaMin + 60, 180);
    eventos.push({
      ...base,
      tipo: EventoTipo.Cancelacion,
      payload: {
        por: "cliente",
        dentro_gracia: dentroGracia,
        gracia_min: graciaMin,
        motivo: turno.motivo,
      },
      origen: EventoOrigen.Public,
      timestamp_utc: new Date(inicio.getTime() - restaMin * MS_MIN),
    });
  }

  // Recordatorio resuelto (RB-CMR-04/05): enviado, fallido o cancelado.
  const programadoPara = new Date(inicio.getTime() - 24 * 3_600_000);
  if (turno.estado === TurnoEstado.Cancelado) {
    recordatorios.push({
      tenant_id: tenantId,
      turno_id: turno.id,
      canal: RecordatorioCanal.Log,
      programado_para: programadoPara,
      estado: RecordatorioEstado.Cancelado,
      intentos: 0,
      ultimo_error: null,
      enviado_en: null,
    });
  } else if (conConfirmacion) {
    const fallido = rng() < 0.08;
    if (fallido) {
      eventos.push({
        ...base,
        tipo: EventoTipo.RecordatorioFallido,
        payload: { canal: "log", intento: 3, error_codigo: "proveedor_caido" },
        origen: EventoOrigen.System,
        timestamp_utc: programadoPara,
      });
      recordatorios.push({
        tenant_id: tenantId,
        turno_id: turno.id,
        canal: RecordatorioCanal.Log,
        programado_para: programadoPara,
        estado: RecordatorioEstado.Fallido,
        intentos: 3,
        ultimo_error: "proveedor_caido",
        enviado_en: null,
      });
    } else {
      eventos.push({
        ...base,
        tipo: EventoTipo.RecordatorioEnviado,
        payload: { canal: "log", lead_min: 1440, intento: 1 },
        origen: EventoOrigen.System,
        timestamp_utc: programadoPara,
      });
      recordatorios.push({
        tenant_id: tenantId,
        turno_id: turno.id,
        canal: RecordatorioCanal.Log,
        programado_para: programadoPara,
        estado: RecordatorioEstado.Enviado,
        intentos: 1,
        ultimo_error: null,
        enviado_en: programadoPara,
      });
    }
  }
}

/** Genera el dataset sintético completo (turnos + eventos + recordatorios). */
export function generarDataset(ctx: Contexto): {
  turnos: NuevoTurno[];
  eventos: NuevoEvento[];
  recordatorios: NuevoRecordatorio[];
} {
  const { timezone, tenantId, servicios, clientes, rng } = ctx;
  const lunes = lunesSemanaLocal(ctx.ahora, timezone);
  const turnos: NuevoTurno[] = [];
  const eventos: NuevoEvento[] = [];
  const recordatorios: NuevoRecordatorio[] = [];
  let indice = 0;

  const semanas: number[] = [...SEMANAS_FUTURAS, 0, ...SEMANAS_HISTORIA];
  for (const w of semanas) {
    for (const k of DIAS_SEMANA) {
      const esSabado = k === 5;
      const horas = esSabado ? HORAS_SABADO : HORAS_ENTRESEMANA;
      const cantidad = 3 + Math.floor(rng() * 3); // 3..5 turnos por día
      const elegidas = mezclar(horas, rng).slice(0, Math.min(cantidad, horas.length));
      for (const hora of elegidas) {
        indice += 1;
        const fecha = fechaLocal(lunes, -7 * w + k);
        const servicio = servicios[Math.floor(rng() * servicios.length)]!;
        const cliente = clientes[Math.floor(rng() * clientes.length)]!;
        const estado = estadoDeSemana(w, rng);
        const inicio = fromZonedTime(`${fecha}T${hora}:00`, timezone);
        const fin = new Date(inicio.getTime() + servicio.duracion_min * MS_MIN);
        // reserva_creada en el lunes 00:00 local de la semana del turno
        // (semanas futuras → semana actual) → KPI1/KPI4 estables.
        const lunesCreacion = fechaLocal(lunes, -7 * Math.max(w, 0));
        const creacion = fromZonedTime(`${lunesCreacion}T00:00:00`, timezone);
        const turno: NuevoTurno = {
          id: randomUUID(),
          tenant_id: tenantId,
          cliente_id: cliente.id,
          servicio_id: servicio.id,
          token_hash: tokenHash(indice),
          fecha_hora_inicio: inicio,
          fecha_hora_fin: fin,
          estado,
          motivo:
            estado === TurnoEstado.Cancelado && rng() < 0.5
              ? "Cambio de planes del cliente"
              : null,
        };
        turnos.push(turno);
        agregarCadena(
          ctx,
          turno,
          creacion,
          servicio.duracion_min,
          servicio.cancellation_grace_minutes,
          eventos,
          recordatorios,
        );
      }
    }
  }

  return { turnos, eventos, recordatorios };
}

/**
 * Cálculo manual (independiente de `metricasService`) de los 4 KPIs a partir
 * del dataset generado y del ancla. Espeja exactamente las definiciones SQL de
 * `metricasRepository` (ventanas, estados y operadores de comparación).
 */
export function calcularKpisEsperados(
  ahora: Date,
  timezone: string,
  turnos: NuevoTurno[],
  eventos: NuevoEvento[],
  capacidadSemana: number,
): KpisEsperados {
  // KPI 1 — reservas por semana ISO (zona negocio), desc, top 8.
  const porSemana = new Map<string, number>();
  for (const e of eventos) {
    if (e.tipo !== EventoTipo.ReservaCreada) continue;
    const semana = formatInTimeZone(e.timestamp_utc, timezone, "RRRR-II");
    porSemana.set(semana, (porSemana.get(semana) ?? 0) + 1);
  }
  const reservas_por_semana = [...porSemana.entries()]
    .map(([semana, cantidad]) => ({ semana, cantidad }))
    .sort((a, b) => b.semana.localeCompare(a.semana))
    .slice(0, 8);

  // KPI 2 — tasa de no-show (inicio < ancla y ≥ ancla − 28d, terminales).
  const desde28 = new Date(ahora.getTime() - 28 * MS_DIA);
  let noShow = 0;
  let terminales = 0;
  for (const t of turnos) {
    const inicio = t.fecha_hora_inicio;
    if (inicio < ahora && inicio >= desde28) {
      if (t.estado === TurnoEstado.NoShow) noShow += 1;
      if (
        t.estado === TurnoEstado.Completado ||
        t.estado === TurnoEstado.NoShow
      ) {
        terminales += 1;
      }
    }
  }
  const tasa_no_show = terminales === 0 ? null : noShow / terminales;

  // KPI 3 — ocupación de la semana actual.
  const inicioSemana = inicioSemanaISO(ahora, timezone);
  const finSemana = finSemanaISO(inicioSemana, timezone);
  let ocupados = 0;
  for (const t of turnos) {
    const inicio = t.fecha_hora_inicio;
    if (inicio < inicioSemana || inicio >= finSemana) continue;
    if (
      t.estado === TurnoEstado.Pendiente ||
      t.estado === TurnoEstado.Confirmado ||
      t.estado === TurnoEstado.Completado
    ) {
      ocupados += 1;
    }
  }
  const ocupacion_semana =
    capacidadSemana === 0 ? null : ocupados / capacidadSemana;

  // KPI 4 — cancelaciones (eventos en [ancla − 28d, ancla]).
  let cancelados = 0;
  let creados = 0;
  for (const e of eventos) {
    if (e.timestamp_utc < desde28 || e.timestamp_utc > ahora) continue;
    if (e.tipo === EventoTipo.Cancelacion) cancelados += 1;
    if (e.tipo === EventoTipo.ReservaCreada) creados += 1;
  }
  const tasa = creados === 0 ? 0 : cancelados / creados;

  return {
    reservas_por_semana,
    tasa_no_show,
    ocupacion_semana,
    cancelaciones: { cantidad: cancelados, tasa },
  };
}

/** Capacidad ofrecida en la semana (denominador de KPI3), misma definición
 *  que `metricasService.calcularCapacidadSemana`: Σ slots por servicio activo
 *  proyectados con `calcularSlots` (sin descontar bloques ni turnos). */
async function capacidadSemana(
  db: Database,
  tenantId: string,
  timezone: string,
  inicio: Date,
  fin: Date,
): Promise<number> {
  const [horarios, servicios] = await Promise.all([
    db.query.horariosRecurrentes.findMany({
      where: (t, { eq }) => eq(t.tenant_id, tenantId),
      columns: { dia_semana: true, hora_inicio: true, hora_fin: true, timezone: true },
    }),
    db.query.servicios.findMany({
      where: (t, { eq }) => eq(t.tenant_id, tenantId),
      columns: { id: true, duracion_min: true, activo: true, booking_window_days: true },
    }),
  ]);
  let capacidad = 0;
  for (const servicio of servicios) {
    if (!servicio.activo) continue;
    capacidad += calcularSlots({
      servicio_id: servicio.id,
      duracion_min: servicio.duracion_min,
      timezone,
      booking_window_days: servicio.booking_window_days,
      horarios,
      bloques: [],
      turnosActivos: [],
      hoy: inicio,
      desde: inicio,
      hasta: fin,
      ahora: inicio,
    }).length;
  }
  return capacidad;
}

/** Elimina el dataset sintético previo del tenant (idempotencia del seed). */
async function limpiarSintetico(db: Database, tenantId: string): Promise<void> {
  await db.delete(eventosMetricas).where(eq(eventosMetricas.tenant_id, tenantId));
  await db
    .delete(recordatoriosTable)
    .where(eq(recordatoriosTable.tenant_id, tenantId));
  await db.delete(turnosTable).where(eq(turnosTable.tenant_id, tenantId));
  await db.delete(clientesTable).where(eq(clientesTable.tenant_id, tenantId));
}

/**
 * Carga el seed sintético en la BD (requiere el seed base ya aplicado: tenant
 * demo + servicios + horarios). Idempotente: borra el dataset sintético previo
 * del tenant antes de regenerarlo. Devuelve los KPIs esperados del dataset.
 */
export async function seedSintetico(
  databaseUrl: string,
  opciones: SeedSinteticoOpciones = {},
): Promise<SeedSinteticoResult> {
  const db = createDb(databaseUrl);
  const env = parseEnv({ ...process.env, DATABASE_URL: databaseUrl });
  const ahora = opciones.ahora ?? new Date();
  const semilla = opciones.semilla ?? SEMILLA_SINTETICA;

  const tenant = await db.query.tenants.findFirst({
    where: (t, { eq }) => eq(t.slug, env.DEFAULT_TENANT_SLUG),
  });
  if (tenant === undefined) {
    throw new Error(
      "No existe el tenant demo. Ejecuta `pnpm --filter @sistema-reservas/api db:seed` primero.",
    );
  }
  const servicios = await db.query.servicios.findMany({
    where: (t, { eq }) => eq(t.tenant_id, tenant.id),
    columns: { id: true, duracion_min: true, cancellation_grace_minutes: true },
  });
  if (servicios.length === 0) {
    throw new Error("El tenant demo no tiene servicios; corre db:seed primero.");
  }
  const horarios = await db.query.horariosRecurrentes.findMany({
    where: (t, { eq }) => eq(t.tenant_id, tenant.id),
    columns: { dia_semana: true, hora_inicio: true, hora_fin: true, timezone: true },
  });

  await limpiarSintetico(db, tenant.id);

  const rng = mulberry32(semilla);
  // Estos campos se setean SIEMPRE acá, aunque `$inferInsert` los declare
  // opcionales (id tiene default en la BD; email/telefono admiten null).
  const clientesNuevos: Array<
    typeof clientesTable.$inferInsert & {
      id: string;
      email: string | null;
      telefono: string | null;
    }
  > = [];
  for (let i = 0; i < CLIENTES_SINTETICOS; i += 1) {
    const n = String(i + 1).padStart(2, "0");
    const conTelefono = i % 4 === 3; // ~25 % solo teléfono (RB-RST-04)
    clientesNuevos.push({
      id: randomUUID(),
      tenant_id: tenant.id,
      nombre: `Cliente Sintético ${n}`,
      email: conTelefono ? null : `cliente.sintetico.${n}@example.com`,
      telefono: `+54 11 5555-${String(1000 + i)}`,
      consentimiento: true,
      consentido_en: ahora,
    });
  }
  await db.insert(clientesTable).values(clientesNuevos);

  const { turnos, eventos, recordatorios } = generarDataset({
    ahora,
    timezone: tenant.timezone,
    tenantId: tenant.id,
    servicios,
    horarios,
    clientes: clientesNuevos.map((c) => ({
      id: c.id,
      email: c.email,
      telefono: c.telefono,
    })),
    rng,
  });

  await db.transaction(async (tx) => {
    await tx.insert(turnosTable).values(turnos);
    await tx.insert(eventosMetricas).values(eventos);
    await tx.insert(recordatoriosTable).values(recordatorios);
  });

  const inicio = inicioSemanaISO(ahora, tenant.timezone);
  const fin = finSemanaISO(inicio, tenant.timezone);
  const capacidad = await capacidadSemana(
    db,
    tenant.id,
    tenant.timezone,
    inicio,
    fin,
  );
  const kpis = calcularKpisEsperados(
    ahora,
    tenant.timezone,
    turnos,
    eventos,
    capacidad,
  );

  return {
    tenant_id: tenant.id,
    clientes: clientesNuevos.length,
    turnos: turnos.length,
    eventos: eventos.length,
    recordatorios: recordatorios.length,
    kpis,
  };
}

/** Escribe el fixture de KPIs (documentado) en disco. */
export function escribirFixture(kpis: KpisEsperados, ruta: string): void {
  const documento = {
    generado_por:
      "apps/api/src/db/seed-sintetico.ts (pnpm --filter @sistema-reservas/api db:seed:sintetico)",
    ancla_utc: ANCLA_SINTETICA.toISOString(),
    zona_horaria: "America/Argentina/Buenos_Aires",
    semilla_prng: SEMILLA_SINTETICA,
    nota:
      "KPIs esperados de GET /api/v1/metricas/resumen (spec A9) con el seed " +
      "sintético. Los calcula el propio generador (cálculo manual documentado " +
      "en seed-sintetico.ts), NO metricasService. El test MTE-S5 compara los " +
      "CONTADOS y tasas (las etiquetas de semana ISO dependen del ancla). " +
      "Regenerar con db:seed:sintetico si cambia el generador.",
    kpis,
  };
  mkdirSync(dirname(ruta), { recursive: true });
  writeFileSync(ruta, `${JSON.stringify(documento, null, 2)}\n`, "utf8");
}

// Ejecución directa: pnpm --filter @sistema-reservas/api db:seed:sintetico
if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  const env = parseEnv();
  (async () => {
    await seedDatabase(env.DATABASE_URL);
    const resultado = await seedSintetico(env.DATABASE_URL, {
      ahora: ANCLA_SINTETICA,
    });
    const rutaFixture = fileURLToPath(
      new URL("../../fixtures/kpis-expected.json", import.meta.url),
    );
    escribirFixture(resultado.kpis, rutaFixture);
    console.log(
      `Seed sintético OK — ${resultado.turnos} turnos, ${resultado.eventos} eventos, ` +
        `${resultado.recordatorios} recordatorios, ${resultado.clientes} clientes. ` +
        `Fixture: ${rutaFixture}`,
    );
    process.exit(0);
  })().catch((error: unknown) => {
    console.error("Seed sintético falló:", error);
    process.exit(1);
  });
}
