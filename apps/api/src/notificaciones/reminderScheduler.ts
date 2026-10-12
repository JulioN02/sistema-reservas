import {
  EventoOrigen,
  EventoTipo,
  TurnoEstado,
} from "@sistema-reservas/contracts";
import type { Database } from "../db";
import type { RecordatorioPendiente } from "../repositories/recordatorioRepository";
import { recordatorioRepository } from "../repositories/recordatorioRepository";
import { eventoService } from "../services/eventoService";
import { construirEnlace } from "./channel";
import type { Notificacion, NotificacionLogger } from "./channel";
import type { NotificationService } from "./notificationService";

/**
 * ReminderScheduler (T-12, diseño §6.2): `sweep()` procesa la cola de
 * recordatorios (la propia tabla) y `iniciarScheduler()` lo corre cada 60 s.
 *
 * Algoritmo por recordatorio vencido:
 * - turno no activo (estado ∉ pendiente/confirmado) o fecha pasada →
 *   `cancelado`, sin envío ni evento (RB-CMR-04/07, CMR-S6/S7);
 * - envío ok → `enviado` + evento `recordatorio_enviado` (CMR-S5);
 * - envío falla y `intentos < 3` → reprograma con backoff 5/15/60 min;
 * - envío falla e `intentos >= 3` → `fallido` + evento `recordatorio_fallido`
 *   (RB-CMR-05, CMR-S4).
 *
 * Los eventos quedan correlacionados por `turno_id` (CA-CMR-05) y sin PII
 * (RB-MTE-04); payloads §13.
 */

/** Backoff de reintentos en minutos (RB-CMR-05). */
export const BACKOFF_MINUTOS = [5, 15, 60] as const;
/** Máximo de reintentos antes de marcar `fallido` (CA-CMR-03). */
export const MAX_INTENTOS = 3;
/** Tope de recordatorios por corrida del sweep (diseño §6.2). */
export const LIMITE_SWEEP = 50;
/** Intervalo por defecto del scheduler en milisegundos. */
export const INTERVALO_SWEEP_MS = 60_000;

/** Estados del turno que admiten recordatorio (RB-CMR-04). */
const ESTADOS_ACTIVOS: readonly TurnoEstado[] = [
  TurnoEstado.Pendiente,
  TurnoEstado.Confirmado,
];

/** ¿El turno NO admite recordatorio (inactivo o con fecha pasada)? */
export function turnoNoEnviable(
  estado: TurnoEstado,
  inicio: Date,
  ahora: Date,
): boolean {
  return !ESTADOS_ACTIVOS.includes(estado) || inicio.getTime() < ahora.getTime();
}

/** Próximo instante de reintento según el backoff (`intentos` 1-based). */
export function siguienteProgramadoPara(intentos: number, ahora: Date): Date {
  const minutos = BACKOFF_MINUTOS[intentos - 1] ?? 60;
  return new Date(ahora.getTime() + minutos * 60_000);
}

export interface SweepOptions {
  leadMin: number;
  ahora?: Date;
  limite?: number;
  logger?: NotificacionLogger;
}

export interface SweepResumen {
  procesados: number;
  enviados: number;
  cancelados: number;
  reprogramados: number;
  fallidos: number;
}

/**
 * Inserta un evento de recordatorio en la MISMA transacción del cambio de
 * estado (CA-MTE-01), origen `system` y correlacionado por `turno_id`.
 */
async function insertarEventoRecordatorio(
  db: Database,
  fila: RecordatorioPendiente,
  tipo: EventoTipo,
  payload: Record<string, unknown>,
): Promise<void> {
  await eventoService.registrar(db, {
    tenant_id: fila.tenant_id,
    turno_id: fila.turno_id,
    cliente_id: fila.cliente_id,
    servicio_id: fila.servicio_id,
    tipo,
    payload,
    origen: EventoOrigen.System,
  });
}

/**
 * Procesa la cola de recordatorios vencidos. `ahora` es inyectable para tests
 * deterministas (evita fake timers contra la BD real).
 */
export async function sweep(
  db: Database,
  service: NotificationService,
  opciones: SweepOptions,
): Promise<SweepResumen> {
  const ahora = opciones.ahora ?? new Date();
  const limite = opciones.limite ?? LIMITE_SWEEP;

  return db.transaction(async (tx) => {
    const txn = tx as unknown as Database;
    const pendientes = await recordatorioRepository.tomarPendientes(
      txn,
      ahora,
      limite,
    );
    const resumen: SweepResumen = {
      procesados: pendientes.length,
      enviados: 0,
      cancelados: 0,
      reprogramados: 0,
      fallidos: 0,
    };

    for (const fila of pendientes) {
      if (turnoNoEnviable(fila.turno_estado, fila.turno_inicio, ahora)) {
        await recordatorioRepository.marcarCancelado(txn, fila.id);
        resumen.cancelados += 1;
        continue;
      }

      const notificacion: Notificacion = {
        canal: fila.canal,
        destinatario: fila.cliente_email,
        cliente_nombre: fila.cliente_nombre,
        servicio: fila.servicio_nombre,
        fecha_hora_inicio: fila.turno_inicio,
        timezone: fila.tenant_timezone,
        // Limitación conocida: la BD solo guarda el sha256 del token
        // (RB-CMR-01, "un leak de BD no expone tokens"), así que el scheduler
        // no puede reconstruir el token crudo. Ver nota de desvío en el
        // retorno de T-12.
        enlace: construirEnlace(fila.turno_token_hash),
        lead_min: opciones.leadMin,
        intento: fila.intentos + 1,
      };
      const resultado = await service.enviar(notificacion);

      if (resultado.ok) {
        await recordatorioRepository.marcarEnviado(txn, fila.id, ahora);
        await insertarEventoRecordatorio(
          txn,
          fila,
          EventoTipo.RecordatorioEnviado,
          {
            canal: fila.canal,
            lead_min: opciones.leadMin,
            intento: fila.intentos + 1,
          },
        );
        resumen.enviados += 1;
        continue;
      }

      const errorCodigo = resultado.error_codigo ?? "error_desconocido";
      if (fila.intentos < MAX_INTENTOS) {
        const nuevosIntentos = fila.intentos + 1;
        await recordatorioRepository.reprogramar(
          txn,
          fila.id,
          nuevosIntentos,
          siguienteProgramadoPara(nuevosIntentos, ahora),
          errorCodigo,
        );
        resumen.reprogramados += 1;
      } else {
        await recordatorioRepository.marcarFallido(
          txn,
          fila.id,
          fila.intentos,
          errorCodigo,
        );
        await insertarEventoRecordatorio(
          txn,
          fila,
          EventoTipo.RecordatorioFallido,
          {
            canal: fila.canal,
            intento: fila.intentos + 1,
            error_codigo: errorCodigo,
          },
        );
        resumen.fallidos += 1;
      }
    }

    return resumen;
  });
}

export interface SchedulerOptions {
  leadMin: number;
  intervaloMs?: number;
  logger?: NotificacionLogger;
}

/** Handle del intervalo activo (singleton por proceso — v1 instancia única). */
let handleActivo: NodeJS.Timeout | null = null;

/**
 * Arranca el sweep periódico. Guard anti doble arranque: devuelve `true` si
 * arrancó y `false` si ya había uno activo. El intervalo usa `unref()` para no
 * mantener vivo el proceso por sí solo.
 */
export function iniciarScheduler(
  db: Database,
  service: NotificationService,
  opciones: SchedulerOptions,
): boolean {
  if (handleActivo !== null) return false;
  const intervaloMs = opciones.intervaloMs ?? INTERVALO_SWEEP_MS;
  handleActivo = setInterval(() => {
    void sweep(db, service, {
      leadMin: opciones.leadMin,
      logger: opciones.logger,
    }).catch((error: unknown) => {
      opciones.logger?.info({ err: error }, "reminder sweep failed");
    });
  }, intervaloMs);
  handleActivo.unref();
  return true;
}

/** Detiene el sweep periódico si estaba activo. */
export function detenerScheduler(): void {
  if (handleActivo !== null) {
    clearInterval(handleActivo);
    handleActivo = null;
  }
}
