import { format, parseISO, startOfISOWeek } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { components } from "@sistema-reservas/contracts";
import type { Database } from "../db";
import { NotFoundError } from "../infra/errors";
import { agendaRepository } from "../repositories/agendaRepository";
import { metricasRepository } from "../repositories/metricasRepository";
import { tenantRepository } from "../repositories/tenantScoped";
import { calcularSlots, sumarDiasEnZona } from "./agendaService";

/**
 * MetricasService (T-16) — proyección sobre datos estructurados (RB-MTE-05:
 * NUNCA tablas agregadas). Calcula los 4 KPIs del resumen de negocio (spec A9,
 * diseño §7.2) en la zona horaria del negocio (RB-MTE-03):
 *
 * - KPI 1 — reservas por semana ISO (8 semanas, `reserva_creada`).
 * - KPI 2 — tasa de no-show (4 semanas, estados terminales post-fecha;
 *   `null` si el denominador es 0).
 * - KPI 3 — ocupación de la semana actual (turnos activos ÷ slots ofrecidos
 *   por `calcularSlots`; `null` sin horarios; MTE-S4 = 5 ÷ 40 = 12.5 %).
 * - KPI 4 — cancelaciones (4 semanas: cantidad + tasa cancelados ÷ creados).
 */

/** Contrato de respuesta de GET /metricas/resumen (openapi.yaml). */
export type MetricasResumen = components["schemas"]["MetricasResumen"];

export interface ResumenOpciones {
  tenant_id: string;
  /** Instante de referencia (inyectable en tests); default `new Date()`. */
  ahora?: Date;
}

/**
 * Lunes 00:00 local (zona del negocio) de la semana ISO que contiene `ahora`
 * (RB-MTE-03: "semana" según la zona del negocio). DST-safe vía date-fns-tz.
 */
export function inicioSemanaISO(ahora: Date, timezone: string): Date {
  const fechaLocal = formatInTimeZone(ahora, timezone, "yyyy-MM-dd");
  const lunes = startOfISOWeek(parseISO(fechaLocal));
  return fromZonedTime(`${format(lunes, "yyyy-MM-dd")}T00:00:00`, timezone);
}

/** Inicio de la semana ISO siguiente (límite exclusivo), +7 días de calendario. */
export function finSemanaISO(inicio: Date, timezone: string): Date {
  return sumarDiasEnZona(inicio, 7, timezone);
}

/** División segura: denominador 0 → `null` (KPI 2 sin datos). */
export function ratio(numerador: number, denominador: number): number | null {
  return denominador === 0 ? null : numerador / denominador;
}

/**
 * Capacidad ofrecida en la semana (denominador de KPI 3): Σ de slots por
 * servicio ACTIVO, proyectados con la misma función pura `calcularSlots` de
 * agenda pero SIN descontar bloques ni turnos (son "slots ofrecidos", no
 * disponibles). `hoy`/`ahora` se fijan al lunes para contar la semana completa
 * (MTE-S4: 8 slots/día × 5 días = 40).
 */
async function calcularCapacidadSemana(
  db: Database,
  tenantId: string,
  timezone: string,
  inicio: Date,
  fin: Date,
): Promise<number> {
  const [horarios, servicios] = await Promise.all([
    agendaRepository.horariosDelTenant(db, tenantId),
    agendaRepository.listarServicios(db, tenantId),
  ]);
  let capacidad = 0;
  for (const servicio of servicios) {
    if (!servicio.activo) continue;
    const slots = calcularSlots({
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
    });
    capacidad += slots.length;
  }
  return capacidad;
}

export const metricasService = {
  /** Resumen de los 4 KPIs del tenant (sesión obligatoria en la ruta). */
  async resumen(
    db: Database,
    opciones: ResumenOpciones,
  ): Promise<MetricasResumen> {
    const ahora = opciones.ahora ?? new Date();
    const tenant = await tenantRepository.porId(db, opciones.tenant_id);
    if (tenant === undefined) {
      throw new NotFoundError("El negocio no está configurado.");
    }
    const timezone = tenant.timezone;

    const inicio = inicioSemanaISO(ahora, timezone);
    const fin = finSemanaISO(inicio, timezone);

    const [reservasPorSemana, noShow, turnosSemana, capacidad, cancelaciones] =
      await Promise.all([
        metricasRepository.reservasPorSemana(db, opciones.tenant_id, timezone),
        metricasRepository.tasaNoShow(db, opciones.tenant_id, ahora),
        metricasRepository.turnosEnSemana(db, opciones.tenant_id, inicio, fin),
        calcularCapacidadSemana(db, opciones.tenant_id, timezone, inicio, fin),
        metricasRepository.cancelacionesPeriodo(db, opciones.tenant_id, ahora),
      ]);

    return {
      reservas_por_semana: reservasPorSemana,
      tasa_no_show: ratio(noShow.no_show, noShow.terminales),
      ocupacion_semana: ratio(turnosSemana, capacidad),
      cancelaciones: {
        cantidad: cancelaciones.cancelados,
        tasa: ratio(cancelaciones.cancelados, cancelaciones.creados) ?? 0,
      },
    };
  },
};
