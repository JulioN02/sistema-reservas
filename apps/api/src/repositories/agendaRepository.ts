import { eq, inArray, sql } from "drizzle-orm";
import { TurnoEstado } from "@sistema-reservas/contracts";
import type { Database } from "../db";
import {
  bloquesIndisponibilidad,
  horariosRecurrentes,
  servicios,
  turnos,
} from "../db/schema";
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
        id: true,
        dia_semana: true,
        hora_inicio: true,
        hora_fin: true,
        timezone: true,
        created_at: true,
      },
      orderBy: (t, { asc }) => [asc(t.dia_semana), asc(t.hora_inicio)],
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
      columns: {
        id: true,
        fecha_hora_inicio: true,
        fecha_hora_fin: true,
      },
    });
  },

  /**
   * Servicio ACTIVO por id DENTRO del tenant (public path: 404 si es de otro
   * tenant O está inactivo — defensa en profundidad, CA-DEF-01 análogo).
   * La gestión de negocio usa `servicioCompletoPorId` (lee también inactivos).
   */
  servicioActivoPorId(db: Database, tenantId: string, servicioId: string) {
    return db.query.servicios.findFirst({
      where: (t) =>
        filtroTenant(
          tenantId,
          t.tenant_id,
          eq(t.id, servicioId),
          eq(t.activo, true),
        ),
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

  // --- Gestión de agenda del negocio (T-09) ---

  /** Horarios del día que solapan [inicio, fin) (RB-AGD-01, bajo lock). */
  horariosQueSolapan(
    db: Database,
    tenantId: string,
    diaSemana: number,
    inicio: string,
    fin: string,
    excluirId?: string,
  ) {
    return db.query.horariosRecurrentes.findMany({
      where: (t) =>
        filtroTenant(
          tenantId,
          t.tenant_id,
          eq(t.dia_semana, diaSemana),
          sql`${t.hora_inicio} < ${fin}::time AND ${t.hora_fin} > ${inicio}::time`,
          ...(excluirId === undefined
            ? []
            : [sql`${t.id} <> ${excluirId}`]),
        ),
      columns: { id: true, hora_inicio: true, hora_fin: true },
    });
  },

  /** Horario completo por id DENTRO del tenant (404 si es de otro — INT-S1). */
  horarioPorId(db: Database, tenantId: string, id: string) {
    return db.query.horariosRecurrentes.findFirst({
      where: (t) => filtroTenant(tenantId, t.tenant_id, eq(t.id, id)),
    });
  },

  async insertarHorario(
    db: Database,
    datos: {
      tenant_id: string;
      dia_semana: number;
      hora_inicio: string;
      hora_fin: string;
      timezone: string;
    },
  ) {
    const filas = await db
      .insert(horariosRecurrentes)
      .values(datos)
      .returning();
    return filas[0]!;
  },

  async actualizarHorario(
    db: Database,
    tenantId: string,
    id: string,
    datos: {
      dia_semana: number;
      hora_inicio: string;
      hora_fin: string;
      timezone: string;
    },
  ) {
    const filas = await db
      .update(horariosRecurrentes)
      .set(datos)
      .where(filtroTenant(tenantId, horariosRecurrentes.tenant_id, eq(horariosRecurrentes.id, id)))
      .returning();
    return filas[0];
  },

  async eliminarHorario(db: Database, tenantId: string, id: string): Promise<boolean> {
    const filas = await db
      .delete(horariosRecurrentes)
      .where(filtroTenant(tenantId, horariosRecurrentes.tenant_id, eq(horariosRecurrentes.id, id)))
      .returning({ id: horariosRecurrentes.id });
    return filas.length > 0;
  },

  /** Bloques del tenant (gestión; incluye motivo/created_at). */
  listarBloques(db: Database, tenantId: string) {
    return db.query.bloquesIndisponibilidad.findMany({
      where: (t) => filtroTenant(tenantId, t.tenant_id),
      orderBy: (t, { desc }) => [desc(t.fecha_inicio)],
    });
  },

  async insertarBloque(
    db: Database,
    datos: {
      tenant_id: string;
      fecha_inicio: Date;
      fecha_fin: Date;
      motivo: string | null;
    },
  ) {
    const filas = await db.insert(bloquesIndisponibilidad).values(datos).returning();
    return filas[0]!;
  },

  async eliminarBloque(db: Database, tenantId: string, id: string): Promise<boolean> {
    const filas = await db
      .delete(bloquesIndisponibilidad)
      .where(filtroTenant(tenantId, bloquesIndisponibilidad.tenant_id, eq(bloquesIndisponibilidad.id, id)))
      .returning({ id: bloquesIndisponibilidad.id });
    return filas.length > 0;
  },

  /** Todos los servicios (negocio) con sus parámetros, ordenados por nombre. */
  listarServicios(db: Database, tenantId: string) {
    return db.query.servicios.findMany({
      where: (t) => filtroTenant(tenantId, t.tenant_id),
      orderBy: (t, { asc }) => [asc(t.nombre)],
    });
  },

  /** Servicio completo por id DENTRO del tenant (gestión). */
  servicioCompletoPorId(db: Database, tenantId: string, id: string) {
    return db.query.servicios.findFirst({
      where: (t) => filtroTenant(tenantId, t.tenant_id, eq(t.id, id)),
    });
  },

  async insertarServicio(
    db: Database,
    datos: {
      tenant_id: string;
      nombre: string;
      duracion_min: number;
      /** numeric(10,2) de la BD se modela como string (drizzle). */
      precio: string | null;
      booking_window_days: number;
      cancellation_grace_minutes: number;
      activo: boolean;
    },
  ) {
    const filas = await db.insert(servicios).values(datos).returning();
    return filas[0]!;
  },

  async actualizarServicio(
    db: Database,
    tenantId: string,
    id: string,
    datos: {
      nombre: string;
      duracion_min: number;
      precio: string | null;
      booking_window_days: number;
      cancellation_grace_minutes: number;
      activo: boolean;
    },
  ) {
    const filas = await db
      .update(servicios)
      .set(datos)
      .where(filtroTenant(tenantId, servicios.tenant_id, eq(servicios.id, id)))
      .returning();
    return filas[0];
  },

  async actualizarParametrosServicio(
    db: Database,
    tenantId: string,
    id: string,
    datos: {
      booking_window_days?: number;
      cancellation_grace_minutes?: number;
      activo?: boolean;
    },
  ) {
    const filas = await db
      .update(servicios)
      .set(datos)
      .where(filtroTenant(tenantId, servicios.tenant_id, eq(servicios.id, id)))
      .returning();
    return filas[0];
  },

  async eliminarServicio(db: Database, tenantId: string, id: string): Promise<boolean> {
    const filas = await db
      .delete(servicios)
      .where(filtroTenant(tenantId, servicios.tenant_id, eq(servicios.id, id)))
      .returning({ id: servicios.id });
    return filas.length > 0;
  },

  /** ¿El servicio tiene turnos asociados? (DELETE → 409 de integridad). */
  async tieneTurnos(
    db: Database,
    tenantId: string,
    servicioId: string,
  ): Promise<boolean> {
    const filas = await db
      .select({ id: turnos.id })
      .from(turnos)
      .where(filtroTenant(tenantId, turnos.tenant_id, eq(turnos.servicio_id, servicioId)))
      .limit(1);
    return filas.length > 0;
  },
};