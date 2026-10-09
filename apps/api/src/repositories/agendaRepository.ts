import { eq, inArray, sql } from "drizzle-orm";
import { TurnoEstado } from "@sistema-reservas/contracts";
import type { Database } from "../db";
import { filtroTenant } from "./tenantScoped";

/**
 * Repositorio de agenda (T-08): queries Drizzle parametrizadas (nunca
 * interpolación, OWASP) con `tenant_id` obligatorio vía filtroTenant
 * (RB-INT-01, INT-S1). El solapamiento de intervalos usa `tstzrange &&`
 * (misma semántica que el claim atómico del diseño §5).
 */

export const agendaRepository = {
  /** Horarios recurrentes del tenant (hora local de pared + timezone, AD-06). */
  horariosDelTenant(db: Database, tenantId: string) {
    return db.query.horariosRecurrentes.findMany({
      where: (t) => filtroTenant(tenantId, t.tenant_id),
      columns: {
        dia_semana: true,
        hora_inicio: true,
        hora_fin: true,
        timezone: true,
      },
    });
  },

  /** Bloques que solapan [desde, hasta) (RB-AGD-03: eliminan slots). */
  bloquesEnRango(db: Database, tenantId: string, desde: Date, hasta: Date) {
    return db.query.bloquesIndisponibilidad.findMany({
      where: (t) =>
        filtroTenant(
          tenantId,
          t.tenant_id,
          sql`tstzrange(${t.fecha_inicio}, ${t.fecha_fin}) && tstzrange(${desde}, ${hasta})`,
        ),
      columns: { fecha_inicio: true, fecha_fin: true },
    });
  },

  /**
   * Turnos ACTIVOS (pendiente/confirmado) de CUALQUIER servicio que solapan
   * [desde, hasta) — RB-AGD-05: todos los servicios compiten por el recurso.
   */
  turnosActivosEnRango(db: Database, tenantId: string, desde: Date, hasta: Date) {
    return db.query.turnos.findMany({
      where: (t) =>
        filtroTenant(
          tenantId,
          t.tenant_id,
          inArray(t.estado, [TurnoEstado.Pendiente, TurnoEstado.Confirmado]),
          sql`tstzrange(${t.fecha_hora_inicio}, ${t.fecha_hora_fin}) && tstzrange(${desde}, ${hasta})`,
        ),
      columns: { fecha_hora_inicio: true, fecha_hora_fin: true },
    });
  },

  /** Servicio por id DENTRO del tenant (404 si es de otro — INT-S1). */
  servicioPorId(db: Database, tenantId: string, servicioId: string) {
    return db.query.servicios.findFirst({
      where: (t) =>
        filtroTenant(tenantId, t.tenant_id, eq(t.id, servicioId)),
      columns: {
        id: true,
        duracion_min: true,
        booking_window_days: true,
      },
    });
  },

  /** Servicios activos del tenant (oferta pública; RB-AGD-05). */
  serviciosActivos(db: Database, tenantId: string) {
    return db.query.servicios.findMany({
      where: (t) => filtroTenant(tenantId, t.tenant_id, eq(t.activo, true)),
      columns: {
        id: true,
        nombre: true,
        duracion_min: true,
        precio: true,
      },
      orderBy: (t, { asc }) => [asc(t.nombre)],
    });
  },
};