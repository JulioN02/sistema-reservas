import { addDays, addMinutes, format, getDay, parseISO } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { Database } from "../db";
import type { Servicio as FilaServicio } from "../db/schema";
import type {
  Bloque,
  BloqueInput,
  DiaAgenda,
  Horario,
  HorarioInput,
  Servicio,
  ServicioInput,
  ServicioParametros,
  ServicioPublico,
} from "../dto/agenda";
import { agendaRepository } from "../repositories/agendaRepository";
import { ConflictError, NotFoundError } from "../infra/errors";
import { assertTenantId } from "../infra/tenant";
import { conLockDeTenant, tenantRepository } from "../repositories/tenantScoped";

/**
 * AgendaService (T-08) — capability agenda-disponibilidad.
 *
 * `calcularSlots` es la proyección pura de disponibilidad (RB-AGD-07: los
 * slots son cálculo, NUNCA una tabla persistida):
 *
 *   slots = horarios_recurrentes − bloques_indisponibilidad − turnos activos
 *
 * Modelo de tiempo (AD-06): los horarios guardan hora local de pared +
 * `timezone`; la conversión a UTC usa date-fns-tz (`fromZonedTime`), que
 * maneja DST (EC-02). Los slots se generan sobre la grilla de 15 minutos
 * (RB-AGD-01) y se ofrecen solo dentro de la ventana de reserva
 * [hoy, hoy + booking_window_days) (RB-AGD-02), sin cruzar el cierre del
 * horario (RB-AGD-04) y nunca en el pasado (RB-AGD-06). Todos los servicios
 * activos compiten por el mismo recurso (RB-AGD-05): los turnos activos de
 * CUALQUIER servicio excluyen rangos.
 */

export interface HorarioProyeccion {
  dia_semana: number;
  hora_inicio: string;
  hora_fin: string;
  timezone: string;
}

export interface BloqueProyeccion {
  fecha_inicio: Date;
  fecha_fin: Date;
}

export interface TurnoProyeccion {
  fecha_hora_inicio: Date;
  fecha_hora_fin: Date;
}

export interface Slot {
  slot_key: string;
  fecha_hora_inicio: Date;
  fecha_hora_fin: Date;
}

export interface CalcularSlotsParams {
  servicio_id: string;
  duracion_min: number;
  /** Zona del negocio: interpreta `hoy`/`desde`/`hasta` (AD-06). */
  timezone: string;
  booking_window_days: number;
  horarios: HorarioProyeccion[];
  bloques: BloqueProyeccion[];
  turnosActivos: TurnoProyeccion[];
  /** Inicio del día de hoy en la zona del negocio (instante UTC). */
  hoy: Date;
  /** Día inicial inclusive (instante UTC = 00:00 local en la zona). */
  desde: Date;
  /** Día final exclusive (instante UTC). */
  hasta: Date;
  /** Instante de consulta: excluye slots ya comenzados (RB-AGD-06). */
  ahora?: Date;
}

/** Solapamiento de intervalos [aIni, aFin) ∩ [bIni, bFin). */
function seSolapan(aIni: Date, aFin: Date, bIni: Date, bFin: Date): boolean {
  return aIni < bFin && bIni < aFin;
}

/** Suma días de CALENDARIO en la zona (robusto ante DST: no suma 24 h UTC). */
function sumarDiasEnZona(instante: Date, dias: number, timezone: string): Date {
  const local = formatInTimeZone(instante, timezone, "yyyy-MM-dd");
  const siguiente = addDays(parseISO(local), dias);
  return fromZonedTime(`${format(siguiente, "yyyy-MM-dd")}T00:00:00`, timezone);
}

/** Inicio del día (00:00 local) de un instante en la zona indicada. */
export function inicioDelDiaEnZona(instante: Date, timezone: string): Date {
  const local = formatInTimeZone(instante, timezone, "yyyy-MM-dd");
  return fromZonedTime(`${local}T00:00:00`, timezone);
}

/**
 * Proyección pura de slots disponibles. Sin efectos ni framework: misma
 * entrada → misma salida (determinista salvo el reloj inyectado `ahora`).
 */
export function calcularSlots(params: CalcularSlotsParams): Slot[] {
  const {
    servicio_id,
    duracion_min,
    timezone,
    booking_window_days,
    horarios,
    bloques,
    turnosActivos,
    hoy,
    desde,
    hasta,
  } = params;
  const ahora = params.ahora ?? hoy;

  // Ventana de reserva [hoy, hoy + booking_window_days) (RB-AGD-02, EC-07);
  // la consulta se recorta a la ventana (CA-AGD-04).
  const finVentana = sumarDiasEnZona(hoy, booking_window_days, timezone);
  const desdeEfectivo = desde > hoy ? desde : hoy;
  const hastaEfectivo = hasta < finVentana ? hasta : finVentana;
  if (desdeEfectivo >= hastaEfectivo) return [];

  // Grilla de 15 min (RB-AGD-01): cuando la duración tiling del reloj
  // (15/30/60) el paso es la propia duración; si no, paso de 15 min.
  const pasoMin = 60 % duracion_min === 0 ? duracion_min : 15;

  const desdeLocal = formatInTimeZone(desdeEfectivo, timezone, "yyyy-MM-dd");
  const hastaLocal = formatInTimeZone(hastaEfectivo, timezone, "yyyy-MM-dd");
  const slots: Slot[] = [];

  for (
    let cursor = parseISO(desdeLocal);
    format(cursor, "yyyy-MM-dd") < hastaLocal;
    cursor = addDays(cursor, 1)
  ) {
    const fechaLocal = format(cursor, "yyyy-MM-dd");
    // Día de la semana 1–7 (lunes = 1), como en la BD.
    const diaSemana = getDay(cursor) === 0 ? 7 : getDay(cursor);

    for (const horario of horarios) {
      if (horario.dia_semana !== diaSemana) continue;

      // Hora local de pared → instante UTC (DST manejado por date-fns-tz).
      const inicioUtc = fromZonedTime(
        `${fechaLocal}T${horario.hora_inicio}`,
        horario.timezone,
      );
      const finUtc = fromZonedTime(
        `${fechaLocal}T${horario.hora_fin}`,
        horario.timezone,
      );

      // Slots alineados que terminan a lo sumo en el cierre (RB-AGD-04).
      for (
        let start = inicioUtc;
        addMinutes(start, duracion_min) <= finUtc;
        start = addMinutes(start, pasoMin)
      ) {
        const end = addMinutes(start, duracion_min);
        if (start < ahora) continue; // RB-AGD-06: nada en el pasado
        if (
          bloques.some((b) => seSolapan(start, end, b.fecha_inicio, b.fecha_fin))
        ) {
          continue; // RB-AGD-03: bloque elimina slots de su(s) fecha(s)
        }
        if (
          turnosActivos.some((t) =>
            seSolapan(start, end, t.fecha_hora_inicio, t.fecha_hora_fin),
          )
        ) {
          continue; // RB-AGD-05: turnos activos de CUALQUIER servicio
        }
        slots.push({
          slot_key: `${start.toISOString()}|${servicio_id}`,
          fecha_hora_inicio: start,
          fecha_hora_fin: end,
        });
      }
    }
  }

  return slots.sort(
    (a, b) => a.fecha_hora_inicio.getTime() - b.fecha_hora_inicio.getTime(),
  );
}

export interface AgendaPublicaOpciones {
  tenant_id: string;
  timezone: string;
  servicio_id: string;
  /** Fecha inicial inclusive (YYYY-MM-DD, zona del negocio). */
  desde: string;
  /** Fecha final exclusive (YYYY-MM-DD, zona del negocio). */
  hasta: string;
  /** Instante de consulta (inyectable en tests); default `new Date()`. */
  ahora?: Date;
}

/** `number | null | undefined` del DTO → string de la columna numeric(10,2). */
function precioAString(precio: number | null | undefined): string | null {
  if (precio === null || precio === undefined) return null;
  return String(precio);
}

/** Fila de `servicios` → Servicio del contrato (sin tenant_id, CA-INT-04). */
function mapaServicioNegocio(
  s: Pick<
    FilaServicio,
    | "id"
    | "nombre"
    | "duracion_min"
    | "precio"
    | "booking_window_days"
    | "cancellation_grace_minutes"
    | "activo"
    | "created_at"
    | "updated_at"
  >,
): Servicio {
  return {
    id: s.id,
    nombre: s.nombre,
    duracion_min: s.duracion_min,
    precio: s.precio === null ? null : Number(s.precio),
    booking_window_days: s.booking_window_days,
    cancellation_grace_minutes: s.cancellation_grace_minutes,
    activo: s.activo,
    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at.toISOString(),
  };
}

export const agendaService = {
  /**
   * Agenda pública de un servicio: valida existencia, consulta horarios /
   * bloques / turnos activos y proyecta un día por fecha del rango
   * (recortado a la ventana de reserva del servicio).
   */
  async agendaPublica(
    db: Database,
    opciones: AgendaPublicaOpciones,
  ): Promise<DiaAgenda[]> {
    assertTenantId(opciones.tenant_id);
    const ahora = opciones.ahora ?? new Date();
    const hoy = inicioDelDiaEnZona(ahora, opciones.timezone);

    const servicio = await agendaRepository.servicioPorId(
      db,
      opciones.tenant_id,
      opciones.servicio_id,
    );
    if (servicio === undefined) {
      throw new NotFoundError("El servicio no existe.");
    }

    const desdeEfectivo = fromZonedTime(
      `${opciones.desde}T00:00:00`,
      opciones.timezone,
    );
    const hastaEfectivo = fromZonedTime(
      `${opciones.hasta}T00:00:00`,
      opciones.timezone,
    );

    // La ventana de reserva recorta la consulta (RB-AGD-02, CA-AGD-04).
    const finVentana = sumarDiasEnZona(
      hoy,
      servicio.booking_window_days,
      opciones.timezone,
    );
    const desdeRecortado = desdeEfectivo > hoy ? desdeEfectivo : hoy;
    const hastaRecortado = hastaEfectivo < finVentana ? hastaEfectivo : finVentana;

    const [horarios, bloques, turnosActivos] = await Promise.all([
      agendaRepository.horariosDelTenant(db, opciones.tenant_id),
      agendaRepository.bloquesEnRango(
        db,
        opciones.tenant_id,
        desdeRecortado,
        hastaRecortado,
      ),
      agendaRepository.turnosActivosEnRango(
        db,
        opciones.tenant_id,
        desdeRecortado,
        hastaRecortado,
      ),
    ]);

    const slots = calcularSlots({
      servicio_id: opciones.servicio_id,
      duracion_min: servicio.duracion_min,
      timezone: opciones.timezone,
      booking_window_days: servicio.booking_window_days,
      horarios,
      bloques,
      turnosActivos,
      hoy,
      desde: desdeRecortado,
      hasta: hastaRecortado,
      ahora,
    });

    // Un día por cada fecha del rango efectivo, aun sin slots (AGD-S2).
    // Los slots se serializan ISO 8601 UTC según el contrato (Slot).
    const dias: DiaAgenda[] = [];
    for (
      let cursor = parseISO(formatInTimeZone(desdeRecortado, opciones.timezone, "yyyy-MM-dd"));
      format(cursor, "yyyy-MM-dd") <
        formatInTimeZone(hastaRecortado, opciones.timezone, "yyyy-MM-dd");
      cursor = addDays(cursor, 1)
    ) {
      const fecha = format(cursor, "yyyy-MM-dd");
      dias.push({
        fecha,
        slots: slots
          .filter(
            (s) =>
              formatInTimeZone(s.fecha_hora_inicio, opciones.timezone, "yyyy-MM-dd") ===
              fecha,
          )
          .map((s) => ({
            slot_key: s.slot_key,
            fecha_hora_inicio: s.fecha_hora_inicio.toISOString(),
            fecha_hora_fin: s.fecha_hora_fin.toISOString(),
          })),
      });
    }
    return dias;
  },

  /** Servicios activos visibles en el flujo público (sin tenant_id, CA-INT-04). */
  async serviciosPublicos(
    db: Database,
    tenantId: string,
  ): Promise<ServicioPublico[]> {
    const [servicios, tenant] = await Promise.all([
      agendaRepository.serviciosActivos(db, tenantId),
      tenantRepository.porId(db, tenantId),
    ]);
    if (tenant === undefined) {
      throw new NotFoundError("El negocio público no está configurado.");
    }
    return servicios.map((s) => ({
      id: s.id,
      nombre: s.nombre,
      duracion_min: s.duracion_min,
      precio: s.precio === null ? null : Number(s.precio),
      zona_horaria: tenant.timezone,
    }));
  },

  // --- Gestión de agenda del negocio (T-09) — sesión obligatoria ---

  async listarHorarios(db: Database, tenantId: string): Promise<Horario[]> {
    const horarios = await agendaRepository.horariosDelTenant(db, tenantId);
    return horarios.map((h) => ({
      id: h.id,
      dia_semana: h.dia_semana,
      hora_inicio: h.hora_inicio,
      hora_fin: h.hora_fin,
      timezone: h.timezone,
      created_at: h.created_at.toISOString(),
    }));
  },

  /**
   * Crea un horario bajo el lock del tenant (RB-AGD-01): si otro horario del
   * mismo día solapa el rango → 409.
   */
  async crearHorario(
    db: Database,
    tenantId: string,
    input: HorarioInput,
  ): Promise<Horario> {
    assertTenantId(tenantId);
    return conLockDeTenant(db, tenantId, async (tx) => {
      const solapados = await agendaRepository.horariosQueSolapan(
        tx,
        tenantId,
        input.dia_semana,
        input.hora_inicio,
        input.hora_fin,
      );
      if (solapados.length > 0) {
        throw new ConflictError(
          "Ya existe un horario que se solapa con el mismo día de la semana.",
        );
      }
      const fila = await agendaRepository.insertarHorario(tx, {
        tenant_id: tenantId,
        ...input,
      });
      return {
        id: fila.id,
        dia_semana: fila.dia_semana,
        hora_inicio: fila.hora_inicio,
        hora_fin: fila.hora_fin,
        timezone: fila.timezone,
        created_at: fila.created_at.toISOString(),
      };
    });
  },

  /**
   * Actualiza un horario bajo el lock del tenant; el 409 de solapamiento
   * excluye al propio horario (PUT idempotente sobre sí mismo).
   */
  async actualizarHorario(
    db: Database,
    tenantId: string,
    id: string,
    input: HorarioInput,
  ): Promise<Horario> {
    assertTenantId(tenantId);
    return conLockDeTenant(db, tenantId, async (tx) => {
      const existente = await agendaRepository.horarioPorId(tx, tenantId, id);
      if (existente === undefined) {
        throw new NotFoundError("El horario no existe.");
      }
      const solapados = await agendaRepository.horariosQueSolapan(
        tx,
        tenantId,
        input.dia_semana,
        input.hora_inicio,
        input.hora_fin,
        id,
      );
      if (solapados.length > 0) {
        throw new ConflictError(
          "Ya existe un horario que se solapa con el mismo día de la semana.",
        );
      }
      const fila = await agendaRepository.actualizarHorario(tx, tenantId, id, {
        ...input,
      });
      if (fila === undefined) {
        throw new NotFoundError("El horario no existe.");
      }
      return {
        id: fila.id,
        dia_semana: fila.dia_semana,
        hora_inicio: fila.hora_inicio,
        hora_fin: fila.hora_fin,
        timezone: fila.timezone,
        created_at: fila.created_at.toISOString(),
      };
    });
  },

  async eliminarHorario(
    db: Database,
    tenantId: string,
    id: string,
  ): Promise<void> {
    const eliminado = await agendaRepository.eliminarHorario(db, tenantId, id);
    if (!eliminado) {
      throw new NotFoundError("El horario no existe.");
    }
  },

  async listarBloques(db: Database, tenantId: string): Promise<Bloque[]> {
    const bloques = await agendaRepository.listarBloques(db, tenantId);
    return bloques.map((b) => ({
      id: b.id,
      fecha_inicio: b.fecha_inicio.toISOString(),
      fecha_fin: b.fecha_fin.toISOString(),
      motivo: b.motivo,
      created_at: b.created_at.toISOString(),
    }));
  },

  /**
   * Crea un bloque bajo el lock del tenant (RB-AGD-03, AGD-S7): si solapa
   * turnos pendiente/confirmado → 409 con detalle de los turnos afectados.
   */
  async crearBloque(
    db: Database,
    tenantId: string,
    input: BloqueInput,
  ): Promise<Bloque> {
    assertTenantId(tenantId);
    return conLockDeTenant(db, tenantId, async (tx) => {
      const afectados = await agendaRepository.turnosActivosEnRango(
        tx,
        tenantId,
        input.fecha_inicio,
        input.fecha_fin,
      );
      if (afectados.length > 0) {
        const detalle =
          `El bloque solapa ${afectados.length} turno(s) activo(s): ` +
          afectados.map((t) => t.id).join(", ");
        throw new ConflictError(detalle);
      }
      const fila = await agendaRepository.insertarBloque(tx, {
        tenant_id: tenantId,
        fecha_inicio: input.fecha_inicio,
        fecha_fin: input.fecha_fin,
        motivo: input.motivo ?? null,
      });
      return {
        id: fila.id,
        fecha_inicio: fila.fecha_inicio.toISOString(),
        fecha_fin: fila.fecha_fin.toISOString(),
        motivo: fila.motivo,
        created_at: fila.created_at.toISOString(),
      };
    });
  },

  async eliminarBloque(
    db: Database,
    tenantId: string,
    id: string,
  ): Promise<void> {
    const eliminado = await agendaRepository.eliminarBloque(db, tenantId, id);
    if (!eliminado) {
      throw new NotFoundError("El bloque no existe.");
    }
  },

  async listarServicios(db: Database, tenantId: string): Promise<Servicio[]> {
    const servicios = await agendaRepository.listarServicios(db, tenantId);
    return servicios.map(mapaServicioNegocio);
  },

  async crearServicio(
    db: Database,
    tenantId: string,
    input: ServicioInput,
  ): Promise<Servicio> {
    const fila = await agendaRepository.insertarServicio(db, {
      tenant_id: tenantId,
      nombre: input.nombre,
      duracion_min: input.duracion_min,
      precio: precioAString(input.precio),
      booking_window_days: input.booking_window_days ?? 30,
      cancellation_grace_minutes: input.cancellation_grace_minutes ?? 180,
      activo: input.activo ?? true,
    });
    return mapaServicioNegocio(fila);
  },

  async actualizarServicio(
    db: Database,
    tenantId: string,
    id: string,
    input: ServicioInput,
  ): Promise<Servicio> {
    const fila = await agendaRepository.actualizarServicio(db, tenantId, id, {
      nombre: input.nombre,
      duracion_min: input.duracion_min,
      precio: precioAString(input.precio),
      booking_window_days: input.booking_window_days ?? 30,
      cancellation_grace_minutes: input.cancellation_grace_minutes ?? 180,
      activo: input.activo ?? true,
    });
    if (fila === undefined) {
      throw new NotFoundError("El servicio no existe.");
    }
    return mapaServicioNegocio(fila);
  },

  async actualizarParametrosServicio(
    db: Database,
    tenantId: string,
    id: string,
    input: ServicioParametros,
  ): Promise<Servicio> {
    const fila = await agendaRepository.actualizarParametrosServicio(
      db,
      tenantId,
      id,
      input,
    );
    if (fila === undefined) {
      throw new NotFoundError("El servicio no existe.");
    }
    return mapaServicioNegocio(fila);
  },

  /** Elimina un servicio; 409 si tiene turnos asociados (integridad). */
  async eliminarServicio(
    db: Database,
    tenantId: string,
    id: string,
  ): Promise<void> {
    const existe = await agendaRepository.servicioCompletoPorId(
      db,
      tenantId,
      id,
    );
    if (existe === undefined) {
      throw new NotFoundError("El servicio no existe.");
    }
    if (await agendaRepository.tieneTurnos(db, tenantId, id)) {
      throw new ConflictError(
        "El servicio tiene turnos asociados y no puede eliminarse.",
      );
    }
    await agendaRepository.eliminarServicio(db, tenantId, id);
  },
};