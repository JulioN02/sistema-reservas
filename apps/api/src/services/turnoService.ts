import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { getDay, parseISO } from "date-fns";
import {
  EventoOrigen,
  EventoTipo,
  RecordatorioCanal,
  TurnoEstado,
} from "@sistema-reservas/contracts";
import type { Database } from "../db";
import type { Turno } from "../db/schema";
import type {
  AccionTurno,
  TurnoAccionResultado,
  TurnoCrearInput,
  TurnoCreado,
  TurnoGestion,
  TurnoReagendarInput,
} from "../dto/turnos";
import { ACCION_TURNO } from "../dto/turnos";
import {
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
  ValidationError,
} from "../infra/errors";
import { construirEnlace } from "../notificaciones/channel";
import type { NotificationService } from "../notificaciones/notificationService";
import { agendaRepository } from "../repositories/agendaRepository";
import { conLockDeTenant, tenantRepository } from "../repositories/tenantScoped";
import type { TurnoConContexto } from "../repositories/turnoRepository";
import { turnoRepository } from "../repositories/turnoRepository";
import { generarTokenOpaco, hashToken } from "./authService";
import { clienteService } from "./clienteService";
import {
  calcularSlots,
  inicioDelDiaEnZona,
  sumarDiasEnZona,
  type HorarioProyeccion,
  type Slot,
} from "./agendaService";

/**
 * TurnoService (T-10) — reserva con claim atómico (diseño §5).
 *
 * `crear` ejecuta el flujo completo en UNA transacción bajo el mutex del
 * tenant (`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`):
 *
 *   1. chequeo de solapamiento `tstzrange &&` sobre turnos ACTIVOS
 *      (pendiente/confirmado) — conflicto → 409 con ≤3 alternativas;
 *   2. upsert de cliente (dedup soft por email/teléfono, RB-RST-06);
 *   3. INSERT turno `pendiente` + token 32 B base64url (sha256 en BD,
 *      enlace `/g/{token}` en la respuesta, RB-CMR-01);
 *   4. evento `reserva_creada` en la MISMA tx (CA-MTE-01, payload §13);
 *   5. programación del recordatorio (inicio − lead; inmediato si ≤ lead,
 *      RB-CMR-03).
 *
 * Red final: el índice único parcial `(tenant_id, fecha_hora_inicio) WHERE
 * estado IN ('pendiente','confirmado')` convierte cualquier violación en
 * 409 por el mismo camino (diseño §5, R-D4).
 */

/** Origen de la reserva: público (tenant por slug) o negocio (sesión). */
export type OrigenReserva =
  | typeof EventoOrigen.Public
  | typeof EventoOrigen.Business;

/** Slot de la oferta (misma proyección que agenda — RB-AGD-07). */
export type SlotOferta = Slot;

/** Vigencia del enlace de gestión (RB-CMR-01): 7 días post-cita. */
export const DIAS_VIGENCIA_ENLACE = 7;

/** Estados terminales del turno (spec §11, EC-12): sin transiciones. */
const ESTADOS_TERMINALES: readonly TurnoEstado[] = [
  TurnoEstado.Cancelado,
  TurnoEstado.Completado,
  TurnoEstado.NoShow,
];

/** ¿El estado es terminal (cancelado/completado/no_show)? */
export function esEstadoTerminal(estado: TurnoEstado): boolean {
  return ESTADOS_TERMINALES.includes(estado);
}

/**
 * ¿El enlace ya expiró? (RB-CMR-01): la vigencia termina 7 días después de
 * la fecha del turno. Borde: exactamente en `inicio + 7d` ya expiró.
 */
export function enlaceExpirado(fechaHoraInicio: Date, ahora: Date): boolean {
  const vence = new Date(
    fechaHoraInicio.getTime() + DIAS_VIGENCIA_ENLACE * 86_400_000,
  );
  return vence.getTime() <= ahora.getTime();
}

const CANALES_CONTACTO = {
  Email: "email",
  Telefono: "telefono",
  Ambos: "ambos",
} as const;
type CanalContacto = (typeof CANALES_CONTACTO)[keyof typeof CANALES_CONTACTO];

export interface CrearTurnoOpciones {
  tenant_id: string;
  input: TurnoCrearInput;
  origen: OrigenReserva;
  /** Lead del recordatorio en minutos (env REMINDER_LEAD_MIN, RB-CMR-03). */
  leadMin: number;
  /** Instante de referencia (inyectable para tests); default `new Date()`. */
  ahora?: Date;
}

/**
 * Programación del recordatorio (RB-CMR-03): `inicio − lead`; si el resto
 * es ≤ lead (inicio ya está dentro del margen) → envío inmediato (`ahora`).
 */
export function calcularProgramadoPara(
  inicio: Date,
  leadMin: number,
  ahora: Date,
): Date {
  const instante = new Date(inicio.getTime() - leadMin * 60_000);
  return instante.getTime() > ahora.getTime() ? instante : ahora;
}

/**
 * Alternativas del 409 (RB-RST-02): los primeros `limite` (3) slots
 * estrictamente posteriores al solicitado, cada uno con su slot_key.
 */
export function elegirAlternativas(
  slots: SlotOferta[],
  solicitado: Date,
  limite = 3,
): string[] {
  return slots
    .filter((s) => s.fecha_hora_inicio.getTime() > solicitado.getTime())
    .slice(0, limite)
    .map((s) => s.slot_key);
}

/**
 * ¿El rango [inicio, fin) cae dentro de algún horario recurrente del
 * tenant? (RB-RST-05: el slot debe pertenecer a la oferta calculada).
 * Hora local de pared + timezone del horario (AD-06, DST vía date-fns-tz).
 */
export function slotEnHorario(
  inicio: Date,
  fin: Date,
  horarios: HorarioProyeccion[],
): boolean {
  for (const h of horarios) {
    const fechaLocal = formatInTimeZone(inicio, h.timezone, "yyyy-MM-dd");
    const diaSemana = getDay(parseISO(fechaLocal)) === 0 ? 7 : getDay(parseISO(fechaLocal));
    if (h.dia_semana !== diaSemana) continue;
    const apertura = fromZonedTime(`${fechaLocal}T${h.hora_inicio}`, h.timezone);
    const cierre = fromZonedTime(`${fechaLocal}T${h.hora_fin}`, h.timezone);
    if (
      inicio.getTime() >= apertura.getTime() &&
      fin.getTime() <= cierre.getTime()
    ) {
      return true;
    }
  }
  return false;
}

/** Canal de contacto del evento (payload §13): email, telefono o ambos. */
function canalContactoDe(cliente: TurnoCrearInput["cliente"]): CanalContacto {
  const email = cliente.email != null;
  const telefono = cliente.telefono != null;
  if (email && telefono) return CANALES_CONTACTO.Ambos;
  return email ? CANALES_CONTACTO.Email : CANALES_CONTACTO.Telefono;
}

/** ¿La excepción es una violación de clave única (SQLSTATE 23505)? */
function esViolacionClaveUnica(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

/** Minutos mínimos post-inicio para marcar no-show (RB-VNG-02). */
export const NO_SHOW_MINUTOS = 30;

/**
 * ¿La cancelación/reagenda del cliente cae dentro de la gracia del servicio?
 * (RB-CRG-01) — gracia = `cancellation_grace_minutes`; dentro si faltan al
 * menos esos minutos para el inicio (borde inclusivo). Comparación de instantes
 * UTC (el margen en minutos es independiente de la zona).
 */
export function dentroDeGracia(
  fechaHoraInicio: Date,
  ahora: Date,
  graciaMin: number,
): boolean {
  return fechaHoraInicio.getTime() - ahora.getTime() >= graciaMin * 60_000;
}

/** Minutos transcurridos desde el inicio del turno (puede ser negativo). */
export function minutosDesdeInicio(
  fechaHoraInicio: Date,
  ahora: Date,
): number {
  return Math.floor((ahora.getTime() - fechaHoraInicio.getTime()) / 60_000);
}

/** Canal de contacto del negocio para el 403 fuera de gracia (RB-CRG-02). */
function canalContactoNegocio(fila: TurnoConContexto): string {
  const partes: string[] = [];
  if (fila.tenant_email_contacto !== null) {
    partes.push(fila.tenant_email_contacto);
  }
  if (fila.tenant_telefono_contacto !== null) {
    partes.push(fila.tenant_telefono_contacto);
  }
  return partes.length > 0 ? partes.join(" / ") : "el negocio";
}

/** Mensaje claro + canal de contacto del negocio (RB-CRG-02, CA-CRG-02). */
function mensajeFueraDeGracia(
  fila: TurnoConContexto,
  graciaMin: number,
): string {
  return (
    `La cancelación está fuera de la ventana de gracia (${graciaMin} min). ` +
    `Contacte al negocio: ${canalContactoNegocio(fila)}.`
  );
}

/**
 * Dependencias opcionales de notificación (RB-CRG-07): el NotificationService
 * abstrae el canal (email en prod, log en dev). Si no se inyecta o el cliente
 * no tiene email, el envío es no-op (el evento de métricas sigue siendo la
 * fuente de verdad del cambio).
 */
export interface NotificacionOpciones {
  notificaciones?: NotificationService;
  ahora?: Date;
}

/**
 * Notifica un cambio de turno por email si el cliente tiene email (RB-CRG-07).
 * Se invoca SIEMPRE post-commit (nunca dentro de la tx) para no notificar
 * cambios revertidos.
 */
async function notificarCambio(
  notificaciones: NotificationService | undefined,
  datos: {
    destinatario: string | null;
    cliente_nombre: string;
    servicio: string;
    fecha_hora_inicio: Date;
    timezone: string;
    enlace: string;
  },
): Promise<void> {
  if (notificaciones === undefined || datos.destinatario === null) return;
  await notificaciones.enviar({
    canal: RecordatorioCanal.Email,
    destinatario: datos.destinatario,
    cliente_nombre: datos.cliente_nombre,
    servicio: datos.servicio,
    fecha_hora_inicio: datos.fecha_hora_inicio,
    timezone: datos.timezone,
    enlace: datos.enlace,
    lead_min: 0,
    intento: 1,
  });
}

/**
 * Resuelve el turno por token SIN aplicar la regla de expiración/terminal de
 * `resolverTurnoPorToken`: la cancelación idempotente (RB-CRG-08) necesita ver
 * un turno ya cancelado para responder 200. Token desconocido → 404 genérico.
 */
async function resolverPorTokenSinTerminal(
  db: Database,
  token: string,
): Promise<TurnoConContexto> {
  const fila = await turnoRepository.turnoGestionPorTokenHash(
    db,
    hashToken(token),
  );
  if (fila === undefined) {
    throw new NotFoundError("El enlace de gestión no es válido.");
  }
  return fila;
}

/**
 * Recalcula la oferta del día (mismo `calcularSlots` de agenda) y devuelve
 * los 3 primeros slots posteriores al solicitado (diseño §5 — Alternativas).
 */
async function calcularAlternativas(
  db: Database,
  tenantId: string,
  servicio: { id: string; duracion_min: number; booking_window_days: number },
  timezone: string,
  solicitado: Date,
  ahora: Date,
): Promise<string[]> {
  const hoy = inicioDelDiaEnZona(ahora, timezone);
  const finVentana = sumarDiasEnZona(hoy, servicio.booking_window_days, timezone);
  const [horarios, bloques, turnosActivos] = await Promise.all([
    agendaRepository.horariosDelTenant(db, tenantId),
    agendaRepository.bloquesEnRango(db, tenantId, hoy, finVentana),
    agendaRepository.turnosActivosEnRango(db, tenantId, hoy, finVentana),
  ]);
  const slots = calcularSlots({
    servicio_id: servicio.id,
    duracion_min: servicio.duracion_min,
    timezone,
    booking_window_days: servicio.booking_window_days,
    horarios,
    bloques,
    turnosActivos,
    hoy,
    desde: hoy,
    hasta: finVentana,
    ahora,
  });
  return elegirAlternativas(slots, solicitado);
}

/**
 * Acciones de negocio (T-14) — sin límite de gracia (RB-CRG-03). Confirmar es
 * idempotente (mismo camino de T-11, `medio: negocio`); cancelar exige motivo
 * (validado en el DTO); completado desde el inicio (RB-VNG-03) y no_show desde
 * inicio + 30 min (RB-VNG-02). Estados terminales → 409 (EC-12).
 */
async function confirmarPorNegocio(
  db: Database,
  fila: TurnoConContexto,
): Promise<TurnoAccionResultado> {
  if (fila.estado === TurnoEstado.Confirmado) {
    return { turno_id: fila.id, estado: fila.estado };
  }
  if (esEstadoTerminal(fila.estado)) {
    throw new ConflictError("El turno alcanzó un estado final.");
  }
  return db.transaction(async (tx) => {
    const txn = tx as unknown as Database;
    const actualizado = await turnoRepository.confirmarSiPendiente(
      txn,
      fila.tenant_id,
      fila.id,
    );
    if (actualizado !== undefined) {
      await turnoRepository.insertarEvento(txn, {
        tenant_id: fila.tenant_id,
        turno_id: fila.id,
        cliente_id: fila.cliente_id,
        servicio_id: fila.servicio_id,
        tipo: EventoTipo.ReservaConfirmada,
        payload: { medio: "negocio" },
        origen: EventoOrigen.Business,
      });
      return { turno_id: fila.id, estado: TurnoEstado.Confirmado };
    }
    const estadoActual = await turnoRepository.turnoEstadoPorId(
      txn,
      fila.tenant_id,
      fila.id,
    );
    if (estadoActual?.estado === TurnoEstado.Confirmado) {
      return { turno_id: fila.id, estado: TurnoEstado.Confirmado };
    }
    throw new ConflictError("El turno alcanzó un estado final.");
  });
}

async function cancelarPorNegocio(
  db: Database,
  fila: TurnoConContexto,
  motivo: string | null,
  opciones: NotificacionOpciones,
  ahora: Date,
): Promise<TurnoAccionResultado> {
  // Idempotente (RB-CRG-08): ya cancelado → 200 sin evento.
  if (fila.estado === TurnoEstado.Cancelado) {
    return { turno_id: fila.id, estado: fila.estado };
  }
  if (esEstadoTerminal(fila.estado)) {
    throw new ConflictError("El turno alcanzó un estado final.");
  }
  const graciaMin = fila.servicio_grace_min;
  const dentro = dentroDeGracia(fila.fecha_hora_inicio, ahora, graciaMin);
  const resultado = await db.transaction(async (tx) => {
    const txn = tx as unknown as Database;
    const actualizado = await turnoRepository.transicionarSiActivo(
      txn,
      fila.tenant_id,
      fila.id,
      TurnoEstado.Cancelado,
      motivo,
    );
    if (actualizado !== undefined) {
      await turnoRepository.insertarEvento(txn, {
        tenant_id: fila.tenant_id,
        turno_id: fila.id,
        cliente_id: fila.cliente_id,
        servicio_id: fila.servicio_id,
        tipo: EventoTipo.Cancelacion,
        payload: {
          por: "negocio",
          dentro_gracia: dentro,
          gracia_min: graciaMin,
          motivo,
        },
        origen: EventoOrigen.Business,
      });
    }
    return { turno_id: fila.id, estado: TurnoEstado.Cancelado };
  });
  await notificarCambio(opciones.notificaciones, {
    destinatario: fila.cliente_email,
    cliente_nombre: fila.cliente_nombre,
    servicio: fila.servicio_nombre,
    fecha_hora_inicio: fila.fecha_hora_inicio,
    timezone: fila.tenant_timezone,
    // Limitación conocida (idéntica al scheduler T-12): la BD solo guarda el
    // sha256 del token; desde el path por id no hay enlace crudo que exponer.
    enlace: construirEnlace(fila.token_hash),
  });
  return resultado;
}

async function completarPorNegocio(
  db: Database,
  fila: TurnoConContexto,
  ahora: Date,
): Promise<TurnoAccionResultado> {
  if (esEstadoTerminal(fila.estado)) {
    throw new ConflictError("El turno alcanzó un estado final.");
  }
  // RB-VNG-03: completado disponible solo desde el inicio del turno.
  if (ahora.getTime() < fila.fecha_hora_inicio.getTime()) {
    throw new ConflictError("El turno aún no ha comenzado (RB-VNG-03).");
  }
  const minutos = minutosDesdeInicio(fila.fecha_hora_inicio, ahora);
  return db.transaction(async (tx) => {
    const txn = tx as unknown as Database;
    const actualizado = await turnoRepository.transicionarSiActivo(
      txn,
      fila.tenant_id,
      fila.id,
      TurnoEstado.Completado,
    );
    if (actualizado === undefined) {
      throw new ConflictError("El turno alcanzó un estado final.");
    }
    await turnoRepository.insertarEvento(txn, {
      tenant_id: fila.tenant_id,
      turno_id: fila.id,
      cliente_id: fila.cliente_id,
      servicio_id: fila.servicio_id,
      tipo: EventoTipo.Completado,
      payload: { minutos_desde_inicio: minutos },
      origen: EventoOrigen.Business,
    });
    return { turno_id: fila.id, estado: TurnoEstado.Completado };
  });
}

async function noShowPorNegocio(
  db: Database,
  fila: TurnoConContexto,
  ahora: Date,
): Promise<TurnoAccionResultado> {
  if (esEstadoTerminal(fila.estado)) {
    throw new ConflictError("El turno alcanzó un estado final.");
  }
  // RB-VNG-02: no_show disponible solo desde inicio + 30 min.
  const umbral = new Date(
    fila.fecha_hora_inicio.getTime() + NO_SHOW_MINUTOS * 60_000,
  );
  if (ahora.getTime() < umbral.getTime()) {
    throw new ConflictError(
      "El no-show solo está disponible desde inicio + 30 min (RB-VNG-02).",
    );
  }
  const minutos = minutosDesdeInicio(fila.fecha_hora_inicio, ahora);
  return db.transaction(async (tx) => {
    const txn = tx as unknown as Database;
    const actualizado = await turnoRepository.transicionarSiActivo(
      txn,
      fila.tenant_id,
      fila.id,
      TurnoEstado.NoShow,
    );
    if (actualizado === undefined) {
      throw new ConflictError("El turno alcanzó un estado final.");
    }
    await turnoRepository.insertarEvento(txn, {
      tenant_id: fila.tenant_id,
      turno_id: fila.id,
      cliente_id: fila.cliente_id,
      servicio_id: fila.servicio_id,
      tipo: EventoTipo.NoShow,
      payload: { minutos_post_inicio: minutos },
      origen: EventoOrigen.Business,
    });
    return { turno_id: fila.id, estado: TurnoEstado.NoShow };
  });
}

export const turnoService = {
  /**
   * Reserva un turno (público o negocio, RST-S8) con claim atómico.
   * Devuelve el contrato TurnoCreado (201); los conflictos lanzan
   * ConflictError con alternativas (409) y las validaciones semánticas
   * ValidationError (422, `errores[]`).
   */
  async crear(db: Database, opciones: CrearTurnoOpciones): Promise<TurnoCreado> {
    const ahora = opciones.ahora ?? new Date();
    const { tenant_id: tenantId, input, origen } = opciones;

    // 0. Servicio ACTIVO del tenant (semántica con BD; la forma ya la validó
    //    el DTO zod — RNF-03). Inexistente o inactivo → 422.
    const servicio = await agendaRepository.servicioActivoPorId(
      db,
      tenantId,
      input.servicio_id,
    );
    if (servicio === undefined) {
      throw new ValidationError([
        {
          campo: "servicio_id",
          mensaje: "El servicio no está disponible para reservas.",
        },
      ]);
    }
    const tenant = await tenantRepository.porId(db, tenantId);
    if (tenant === undefined) {
      throw new NotFoundError("El negocio no está configurado.");
    }

    const inicio = input.slot_key.inicio_utc;
    const fin = new Date(inicio.getTime() + servicio.duracion_min * 60_000);

    // 1. Temporales pre-claim (RB-RST-05, EC-12, RB-AGD-02): pasado → 422
    //    (RST-S6/CA-RST-04); fuera de la ventana del servicio → 422.
    if (inicio.getTime() < ahora.getTime()) {
      throw new ValidationError([
        { campo: "slot_key", mensaje: "No se puede reservar en el pasado." },
      ]);
    }
    const hoy = inicioDelDiaEnZona(ahora, tenant.timezone);
    const finVentana = sumarDiasEnZona(
      hoy,
      servicio.booking_window_days,
      tenant.timezone,
    );
    if (
      inicio.getTime() < hoy.getTime() ||
      inicio.getTime() >= finVentana.getTime()
    ) {
      throw new ValidationError([
        {
          campo: "slot_key",
          mensaje: "El slot está fuera de la ventana de reserva del servicio.",
        },
      ]);
    }

    // 2. Disponibilidad estática sin lock (solo lectura): el slot debe
    //    pertenecer a la oferta — horario del día (RB-AGD-04) y sin bloque
    //    (RB-AGD-03). Si no → 409 con alternativas (RB-RST-02).
    const [horarios, bloques] = await Promise.all([
      agendaRepository.horariosDelTenant(db, tenantId),
      agendaRepository.bloquesEnRango(db, tenantId, inicio, fin),
    ]);
    if (!slotEnHorario(inicio, fin, horarios) || bloques.length > 0) {
      throw new ConflictError(
        "El slot solicitado ya no está disponible.",
        await calcularAlternativas(
          db,
          tenantId,
          servicio,
          tenant.timezone,
          inicio,
          ahora,
        ),
      );
    }

    // 3. Claim atómico (diseño §5): mutex del tenant → re-chequeo de
    //    solapamiento → upsert cliente → INSERT turno + evento + recordatorio
    //    en la MISMA transacción (CA-MTE-01: exactamente 1 evento).
    return conLockDeTenant(db, tenantId, async (tx) => {
      const solapa = await turnoRepository.hayTurnoActivoQueSolapa(
        tx,
        tenantId,
        inicio,
        fin,
      );
      if (solapa) {
        throw new ConflictError(
          "El slot solicitado ya no está disponible.",
          await calcularAlternativas(
            tx,
            tenantId,
            servicio,
            tenant.timezone,
            inicio,
            ahora,
          ),
        );
      }

      // Upsert cliente (dedup soft por email/teléfono; RB-RST-06/EC-16).
      const cliente = await clienteService.obtenerOCrear(
        tx,
        tenantId,
        input.cliente,
      );

      // Token opaco 32 B base64url (≥128 bits); la BD guarda sha256 y la
      // respuesta expone el enlace `/g/{token}` (RB-CMR-01, RB-INT-02).
      const token = generarTokenOpaco();
      let fila: Turno;
      try {
        fila = await turnoRepository.insertarTurno(tx, {
          tenant_id: tenantId,
          cliente_id: cliente.id,
          servicio_id: input.servicio_id,
          token_hash: hashToken(token),
          fecha_hora_inicio: inicio,
          fecha_hora_fin: fin,
          estado: TurnoEstado.Pendiente,
        });
      } catch (error) {
        if (esViolacionClaveUnica(error)) {
          // Red final del claim: índice único parcial de inicios activos.
          throw new ConflictError(
            "El slot solicitado ya no está disponible.",
            await calcularAlternativas(
              tx,
              tenantId,
              servicio,
              tenant.timezone,
              inicio,
              ahora,
            ),
          );
        }
        throw error;
      }

      // Evento reserva_creada en la MISMA tx (CA-MTE-01); payload §13 sin
      // PII (RB-MTE-04): solo instantes, canal de contacto y creador.
      await turnoRepository.insertarEvento(tx, {
        tenant_id: tenantId,
        turno_id: fila.id,
        cliente_id: cliente.id,
        servicio_id: input.servicio_id,
        tipo: EventoTipo.ReservaCreada,
        payload: {
          slot_inicio_utc: inicio.toISOString(),
          slot_fin_utc: fin.toISOString(),
          canal_contacto: canalContactoDe(input.cliente),
          creado_por: origen === EventoOrigen.Business ? "negocio" : "cliente",
        },
        origen,
      });

      // Recordatorio (RB-CMR-03): canal email solo si el cliente tiene email
      // (RB-RST-04: solo teléfono → sin email programado; el enlace queda
      // disponible al negocio); programado_para = inicio − lead (o ahora si
      // el resto ≤ lead → envío inmediato).
      const canal =
        cliente.email !== null
          ? RecordatorioCanal.Email
          : RecordatorioCanal.Log;
      await turnoRepository.insertarRecordatorio(tx, {
        tenant_id: tenantId,
        turno_id: fila.id,
        canal,
        programado_para: calcularProgramadoPara(inicio, opciones.leadMin, ahora),
      });

      return {
        turno_id: fila.id,
        estado: fila.estado,
        enlace_gestion: `/g/${token}`,
        cliente_id: cliente.id,
      };
    });
  },

  /**
   * Resuelve el turno por token con los datos de gestión (también usado por
   * GET /turnos/{token} y POST /turnos/{token}/confirmar — T-11). Nunca
   * revela la existencia del turno (CMR-S3, RB-INT-02):
   * - token desconocido → 404 genérico (igual para token malformado);
   * - estado terminal o expirado (7 días post-cita, RB-CMR-01) → 410.
   */
  async resolverTurnoPorToken(
    db: Database,
    token: string,
    ahora?: Date,
  ): Promise<TurnoConContexto> {
    const fila = await turnoRepository.turnoGestionPorTokenHash(
      db,
      hashToken(token),
    );
    if (fila === undefined) {
      throw new NotFoundError("El enlace de gestión no es válido.");
    }
    const instante = ahora ?? new Date();
    if (
      esEstadoTerminal(fila.estado) ||
      enlaceExpirado(fila.fecha_hora_inicio, instante)
    ) {
      throw new GoneError("El enlace expiró o el turno alcanzó un estado final.");
    }
    return fila;
  },

  /**
   * GET /turnos/{token} → TurnoGestion {estado, servicio,
   * fecha_hora_inicio/fin, cliente_nombre} (diseño §4.2, aditivo). Sin
   * tenant_id (CA-INT-04); 404/410 sin revelar datos (CMR-S3).
   */
  async obtenerPorToken(
    db: Database,
    token: string,
    ahora?: Date,
  ): Promise<TurnoGestion> {
    const fila = await turnoService.resolverTurnoPorToken(db, token, ahora);
    return {
      estado: fila.estado,
      servicio: fila.servicio_nombre,
      fecha_hora_inicio: fila.fecha_hora_inicio.toISOString(),
      fecha_hora_fin: fila.fecha_hora_fin.toISOString(),
      cliente_nombre: fila.cliente_nombre,
    };
  },

  /**
   * POST /turnos/{token}/confirmar (T-11, RB-CMR-02): UPDATE condicional
   * idempotente `pendiente → confirmado` + evento `reserva_confirmada
   * {medio: enlace}` en la MISMA transacción (CA-CMR-01, CA-MTE-01).
   *
   * - ya confirmado → 200 SIN evento duplicado (CMR-S2);
   * - terminal o expirado → 410 (CMR-S3); token desconocido → 404;
   * - concurrencia: el lock de fila del UPDATE serializa; solo la tx que
   *   transiciona escribe el evento (exactamente-1).
   */
  async confirmar(
    db: Database,
    token: string,
    ahora?: Date,
  ): Promise<TurnoAccionResultado> {
    const fila = await turnoService.resolverTurnoPorToken(db, token, ahora);

    // Idempotente: ya confirmado → 200 sin evento nuevo (CA-CMR-01).
    if (fila.estado === TurnoEstado.Confirmado) {
      return { turno_id: fila.id, estado: fila.estado };
    }

    return db.transaction(async (tx) => {
      const txn = tx as unknown as Database;
      const actualizado = await turnoRepository.confirmarSiPendiente(
        txn,
        fila.tenant_id,
        fila.id,
      );
      if (actualizado !== undefined) {
        // Evento en la misma tx del cambio de estado (exactamente-1).
        await turnoRepository.insertarEvento(txn, {
          tenant_id: fila.tenant_id,
          turno_id: fila.id,
          cliente_id: fila.cliente_id,
          servicio_id: fila.servicio_id,
          tipo: EventoTipo.ReservaConfirmada,
          payload: { medio: "enlace" },
          origen: EventoOrigen.Public,
        });
        return { turno_id: fila.id, estado: TurnoEstado.Confirmado };
      }

      // 0 filas: otra transición ganó la carrera. Si quedó confirmado →
      // 200 sin evento; cualquier otro estado (terminal) → 410.
      const estadoActual = await turnoRepository.turnoEstadoPorId(
        txn,
        fila.tenant_id,
        fila.id,
      );
      if (estadoActual?.estado === TurnoEstado.Confirmado) {
        return { turno_id: fila.id, estado: TurnoEstado.Confirmado };
      }
      throw new GoneError(
        "El enlace expiró o el turno alcanzó un estado final.",
      );
    });
  },

  /**
   * POST /turnos/{token}/cancelar (T-14, RB-CRG-01/02/08, CA-CRG-01/02/05):
   * - cliente dentro de gracia → cancelado + evento `cancelacion {por:cliente,
   *   dentro_gracia, gracia_min, motivo}` en la MISMA tx; el slot queda
   *   re-ofertable al instante (proyección: el turno deja de estar activo);
   * - ya cancelado → 200 idempotente SIN evento (RB-CRG-08);
   * - fuera de gracia → 403 con canal de contacto, turno intacto (CA-CRG-02);
   * - terminal (completado/no_show) → 409; expirado → 410; token → 404.
   */
  async cancelar(
    db: Database,
    token: string,
    opciones: NotificacionOpciones = {},
  ): Promise<TurnoAccionResultado> {
    const ahora = opciones.ahora ?? new Date();
    const fila = await resolverPorTokenSinTerminal(db, token);

    // RB-CRG-08: cancelar un turno ya cancelado es idempotente (sin evento).
    if (fila.estado === TurnoEstado.Cancelado) {
      return { turno_id: fila.id, estado: fila.estado };
    }
    if (esEstadoTerminal(fila.estado)) {
      throw new ConflictError("El turno alcanzó un estado final.");
    }
    if (enlaceExpirado(fila.fecha_hora_inicio, ahora)) {
      throw new GoneError(
        "El enlace expiró o el turno alcanzó un estado final.",
      );
    }

    const graciaMin = fila.servicio_grace_min;
    const dentro = dentroDeGracia(fila.fecha_hora_inicio, ahora, graciaMin);
    if (!dentro) {
      // RB-CRG-02: el turno permanece intacto (no se escribe ni evento).
      throw new ForbiddenError(mensajeFueraDeGracia(fila, graciaMin));
    }

    const resultado = await db.transaction(async (tx) => {
      const txn = tx as unknown as Database;
      const actualizado = await turnoRepository.transicionarSiActivo(
        txn,
        fila.tenant_id,
        fila.id,
        TurnoEstado.Cancelado,
        null,
      );
      if (actualizado !== undefined) {
        await turnoRepository.insertarEvento(txn, {
          tenant_id: fila.tenant_id,
          turno_id: fila.id,
          cliente_id: fila.cliente_id,
          servicio_id: fila.servicio_id,
          tipo: EventoTipo.Cancelacion,
          payload: {
            por: "cliente",
            dentro_gracia: dentro,
            gracia_min: graciaMin,
            motivo: null,
          },
          origen: EventoOrigen.Public,
        });
      }
      return { turno_id: fila.id, estado: TurnoEstado.Cancelado };
    });

    // RB-CRG-07: notificación (email si el cliente tiene email), post-commit.
    await notificarCambio(opciones.notificaciones, {
      destinatario: fila.cliente_email,
      cliente_nombre: fila.cliente_nombre,
      servicio: fila.servicio_nombre,
      fecha_hora_inicio: fila.fecha_hora_inicio,
      timezone: fila.tenant_timezone,
      enlace: construirEnlace(token),
    });

    return resultado;
  },

  /**
   * POST /turnos/{token}/reagendar (T-14, RB-CRG-04/05, CA-CRG-03): mueve el
   * MISMO turno a un nuevo slot en una transacción atómica (libera el anterior
   * + reclama el nuevo). Conserva id/cliente/servicio/estado; mismas
   * validaciones de slot que la reserva (RST-05). Ocupado/no-ofertado → 409
   * con alternativas y el turno conserva su horario original (CRG-S5).
   */
  async reagendar(
    db: Database,
    token: string,
    input: TurnoReagendarInput,
    opciones: NotificacionOpciones = {},
  ): Promise<TurnoAccionResultado> {
    const ahora = opciones.ahora ?? new Date();
    const fila = await resolverPorTokenSinTerminal(db, token);

    if (esEstadoTerminal(fila.estado)) {
      throw new ConflictError("El turno alcanzó un estado final.");
    }
    if (enlaceExpirado(fila.fecha_hora_inicio, ahora)) {
      throw new GoneError(
        "El enlace expiró o el turno alcanzó un estado final.",
      );
    }

    const graciaMin = fila.servicio_grace_min;
    const dentro = dentroDeGracia(fila.fecha_hora_inicio, ahora, graciaMin);
    if (!dentro) {
      throw new ForbiddenError(mensajeFueraDeGracia(fila, graciaMin));
    }

    // RB-CRG-04: reagendar conserva el servicio del turno.
    if (input.servicio_id !== fila.servicio_id) {
      throw new ValidationError([
        {
          campo: "slot_key",
          mensaje: "slot_key no corresponde al servicio del turno.",
        },
      ]);
    }

    const inicio = input.inicio_utc;
    const fin = new Date(inicio.getTime() + fila.servicio_duracion_min * 60_000);
    const servicio = {
      id: fila.servicio_id,
      duracion_min: fila.servicio_duracion_min,
      booking_window_days: fila.servicio_booking_window_days,
    };

    // RB-RST-05: el nuevo slot debe pertenecer a la oferta calculada.
    if (inicio.getTime() < ahora.getTime()) {
      throw new ValidationError([
        { campo: "slot_key", mensaje: "No se puede reagendar al pasado." },
      ]);
    }
    const hoy = inicioDelDiaEnZona(ahora, fila.tenant_timezone);
    const finVentana = sumarDiasEnZona(
      hoy,
      fila.servicio_booking_window_days,
      fila.tenant_timezone,
    );
    if (
      inicio.getTime() < hoy.getTime() ||
      inicio.getTime() >= finVentana.getTime()
    ) {
      throw new ValidationError([
        {
          campo: "slot_key",
          mensaje: "El slot está fuera de la ventana de reserva del servicio.",
        },
      ]);
    }

    const [horarios, bloques] = await Promise.all([
      agendaRepository.horariosDelTenant(db, fila.tenant_id),
      agendaRepository.bloquesEnRango(db, fila.tenant_id, inicio, fin),
    ]);
    if (!slotEnHorario(inicio, fin, horarios) || bloques.length > 0) {
      throw new ConflictError(
        "El slot solicitado ya no está disponible.",
        await calcularAlternativas(
          db,
          fila.tenant_id,
          servicio,
          fila.tenant_timezone,
          inicio,
          ahora,
        ),
      );
    }

    // Claim atómico (diseño §5): mutex del tenant → re-chequeo de solapamiento
    // EXCLUYENDO el propio turno → UPDATE atómico (libera + reclama) + evento.
    const resultado = await conLockDeTenant(db, fila.tenant_id, async (tx) => {
      const solapa = await turnoRepository.hayTurnoActivoQueSolapa(
        tx,
        fila.tenant_id,
        inicio,
        fin,
        fila.id,
      );
      if (solapa) {
        throw new ConflictError(
          "El slot solicitado ya no está disponible.",
          await calcularAlternativas(
            tx,
            fila.tenant_id,
            servicio,
            fila.tenant_timezone,
            inicio,
            ahora,
          ),
        );
      }
      let actualizado: { id: string; estado: TurnoEstado } | undefined;
      try {
        actualizado = await turnoRepository.reagendarTurno(
          tx,
          fila.tenant_id,
          fila.id,
          inicio,
          fin,
        );
      } catch (error) {
        if (esViolacionClaveUnica(error)) {
          throw new ConflictError(
            "El slot solicitado ya no está disponible.",
            await calcularAlternativas(
              tx,
              fila.tenant_id,
              servicio,
              fila.tenant_timezone,
              inicio,
              ahora,
            ),
          );
        }
        throw error;
      }
      if (actualizado === undefined) {
        throw new ConflictError("El turno alcanzó un estado final.");
      }
      await turnoRepository.insertarEvento(tx, {
        tenant_id: fila.tenant_id,
        turno_id: fila.id,
        cliente_id: fila.cliente_id,
        servicio_id: fila.servicio_id,
        tipo: EventoTipo.Reagendulacion,
        payload: {
          slot_anterior_utc: fila.fecha_hora_inicio.toISOString(),
          slot_nuevo_utc: inicio.toISOString(),
          por: "cliente",
          dentro_gracia: dentro,
        },
        origen: EventoOrigen.Public,
      });
      return {
        turno_id: fila.id,
        estado: actualizado.estado,
        fecha_hora_inicio: inicio.toISOString(),
        fecha_hora_fin: fin.toISOString(),
      };
    });

    await notificarCambio(opciones.notificaciones, {
      destinatario: fila.cliente_email,
      cliente_nombre: fila.cliente_nombre,
      servicio: fila.servicio_nombre,
      fecha_hora_inicio: inicio,
      timezone: fila.tenant_timezone,
      enlace: construirEnlace(token),
    });

    return resultado;
  },

  /**
   * POST /turnos/{id}/acciones (T-14, RB-VNG-02/03/04, CA-CRG-04, EC-12):
   * acciones del negocio sobre un turno del propio tenant. Sin límite de
   * gracia; `motivo` obligatorio para cancelar (validado en el DTO, CA-CRG-04).
   * Estados terminales → 409; turno inexistente/de otro tenant → 404.
   */
  async accion(
    db: Database,
    tenantId: string,
    turnoId: string,
    input: { accion: AccionTurno; motivo: string | null },
    opciones: NotificacionOpciones = {},
  ): Promise<TurnoAccionResultado> {
    const ahora = opciones.ahora ?? new Date();
    const fila = await turnoRepository.turnoConContextoPorId(
      db,
      tenantId,
      turnoId,
    );
    if (fila === undefined) {
      throw new NotFoundError("El turno no existe.");
    }

    switch (input.accion) {
      case ACCION_TURNO.Confirmar:
        return confirmarPorNegocio(db, fila);
      case ACCION_TURNO.Cancelar:
        return cancelarPorNegocio(db, fila, input.motivo, opciones, ahora);
      case ACCION_TURNO.Completado:
        return completarPorNegocio(db, fila, ahora);
      case ACCION_TURNO.NoShow:
        return noShowPorNegocio(db, fila, ahora);
    }
  },
};