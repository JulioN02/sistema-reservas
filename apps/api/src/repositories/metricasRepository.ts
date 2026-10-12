import { eq, inArray, sql } from "drizzle-orm";
import { EventoTipo, TurnoEstado } from "@sistema-reservas/contracts";
import type { EventoOrigen } from "@sistema-reservas/contracts";
import type { Database } from "../db";
import { eventosMetricas, turnos } from "../db/schema";
import { filtroTenant } from "./tenantScoped";

/**
 * Repositorio de métricas (T-16): eventos append-only + las consultas de
 * proyección de los 4 KPIs (RB-MTE-05: NUNCA tablas agregadas). Queries
 * Drizzle parametrizadas (nunca interpolación, OWASP) con `tenant_id`
 * obligatorio vía filtroTenant (RB-INT-01, INT-S1).
 */

/** Datos de un evento de métricas (payload §13, sin PII — RB-MTE-04). */
export interface EventoMetricaInput {
  tenant_id: string;
  turno_id: string;
  cliente_id?: string | null;
  servicio_id?: string | null;
  tipo: EventoTipo;
  payload: Record<string, unknown>;
  origen: EventoOrigen;
}

/** Fila de KPI 1 — reservas por semana ISO (formato IYYY-IW). */
export interface ReservaSemanaFila {
  semana: string;
  cantidad: number;
}

/** Conteos crudos de KPI 2 — tasa de no-show. */
export interface TasaNoShowFila {
  no_show: number;
  terminales: number;
}

/** Conteos crudos de KPI 4 — cancelaciones del período. */
export interface CancelacionesFila {
  cancelados: number;
  creados: number;
}

/** Ventana de 4 semanas hacia atrás desde `ahora` (KPI 2 y KPI 4). */
const DIAS_VENTANA_CORTA = 28;
/** Semanas ISO devueltas por KPI 1. */
const SEMANAS_KPI1 = 8;

export const metricasRepository = {
  /**
   * Inserta UN evento en `eventos_metricas` (RB-MTE-01). Se invoca SIEMPRE
   * dentro de la misma transacción del cambio de estado (CA-MTE-01,
   * exactamente-1). El `evento_id` es PK con default (anti-duplicado).
   */
  async insertarEvento(db: Database, datos: EventoMetricaInput) {
    const filas = await db
      .insert(eventosMetricas)
      .values({
        tenant_id: datos.tenant_id,
        turno_id: datos.turno_id,
        cliente_id: datos.cliente_id ?? null,
        servicio_id: datos.servicio_id ?? null,
        tipo: datos.tipo,
        payload: datos.payload,
        origen: datos.origen,
      })
      .returning();
    return filas[0]!;
  },

  /**
   * KPI 1 — reservas por semana ISO en la zona del negocio (RB-MTE-03).
   * Agrupa `reserva_creada` por `to_char(timestamp_utc AT TIME ZONE $tz,
   * 'IYYY-IW')`, ordena desc y limita a las 8 semanas más recientes.
   */
  async reservasPorSemana(
    db: Database,
    tenantId: string,
    timezone: string,
  ): Promise<ReservaSemanaFila[]> {
    const semana = sql`to_char(${eventosMetricas.timestamp_utc} AT TIME ZONE ${timezone}, 'IYYY-IW')`;
    return db
      .select({
        semana: sql<string>`${semana}`,
        cantidad: sql<number>`count(*)::int`,
      })
      .from(eventosMetricas)
      .where(
        filtroTenant(
          tenantId,
          eventosMetricas.tenant_id,
          eq(eventosMetricas.tipo, EventoTipo.ReservaCreada),
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1 DESC`)
      .limit(SEMANAS_KPI1);
  },

  /**
   * KPI 2 — numerador/denominador de la tasa de no-show (RB-MTE-03): turnos
   * con fecha YA PASADA (`< ahora`) dentro de las últimas 4 semanas, sobre
   * estados terminales. El servicio decide `null` si el denominador es 0.
   */
  async tasaNoShow(
    db: Database,
    tenantId: string,
    ahora: Date,
  ): Promise<TasaNoShowFila> {
    const desde = new Date(ahora.getTime() - DIAS_VENTANA_CORTA * 86_400_000);
    const filas = await db
      .select({
        no_show: sql<number>`count(*) FILTER (WHERE ${turnos.estado} = ${TurnoEstado.NoShow})::int`,
        terminales: sql<number>`count(*) FILTER (WHERE ${turnos.estado} IN (${TurnoEstado.Completado}, ${TurnoEstado.NoShow}))::int`,
      })
      .from(turnos)
      .where(
        filtroTenant(
          tenantId,
          turnos.tenant_id,
          sql`${turnos.fecha_hora_inicio} < ${ahora}`,
          sql`${turnos.fecha_hora_inicio} >= ${desde}`,
        ),
      );
    return filas[0]!;
  },

  /**
   * KPI 3 (numerador) — turnos de la semana con estado pendiente/confirmado/
   * completado (los que "ocupan" la capacidad ofrecida).
   */
  async turnosEnSemana(
    db: Database,
    tenantId: string,
    desde: Date,
    hasta: Date,
  ): Promise<number> {
    const filas = await db
      .select({ cantidad: sql<number>`count(*)::int` })
      .from(turnos)
      .where(
        filtroTenant(
          tenantId,
          turnos.tenant_id,
          inArray(turnos.estado, [
            TurnoEstado.Pendiente,
            TurnoEstado.Confirmado,
            TurnoEstado.Completado,
          ]),
          sql`${turnos.fecha_hora_inicio} >= ${desde}`,
          sql`${turnos.fecha_hora_inicio} < ${hasta}`,
        ),
      );
    return filas[0]?.cantidad ?? 0;
  },

  /**
   * KPI 4 — cancelaciones del período (4 semanas) desde `eventos_metricas`:
   * `cancelados` = eventos `cancelacion`; `creados` = eventos
   * `reserva_creada`. El servicio deriva la tasa.
   */
  async cancelacionesPeriodo(
    db: Database,
    tenantId: string,
    ahora: Date,
  ): Promise<CancelacionesFila> {
    const desde = new Date(ahora.getTime() - DIAS_VENTANA_CORTA * 86_400_000);
    const filas = await db
      .select({
        cancelados: sql<number>`count(*) FILTER (WHERE ${eventosMetricas.tipo} = ${EventoTipo.Cancelacion})::int`,
        creados: sql<number>`count(*) FILTER (WHERE ${eventosMetricas.tipo} = ${EventoTipo.ReservaCreada})::int`,
      })
      .from(eventosMetricas)
      .where(
        filtroTenant(
          tenantId,
          eventosMetricas.tenant_id,
          sql`${eventosMetricas.timestamp_utc} >= ${desde}`,
          sql`${eventosMetricas.timestamp_utc} <= ${ahora}`,
        ),
      );
    return filas[0]!;
  },
};
