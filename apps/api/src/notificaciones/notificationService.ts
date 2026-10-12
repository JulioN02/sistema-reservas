import { RecordatorioCanal } from "@sistema-reservas/contracts";
import type { Env } from "../config/env";
import type {
  Notificacion,
  NotificationChannel,
  NotificacionLogger,
  ResultadoEnvio,
} from "./channel";
import { EmailChannel } from "./emailChannel";
import { LogChannel } from "./logChannel";

/**
 * NotificationService (diseño §6.1): traduce un evento de dominio a un canal
 * concreto y despacha. La selección combina la configuración de entorno
 * (`NOTIFICATION_CHANNEL`) con el canal del recordatorio:
 *
 * - `NOTIFICATION_CHANNEL=log`  → SIEMPRE LogChannel (dev/demo, sin key).
 * - `NOTIFICATION_CHANNEL=email` → respeta `recordatorios.canal`
 *   (email → EmailChannel; log → LogChannel).
 *
 * `enviar` devuelve el `ResultadoEnvio` tal cual: el scheduler decide el
 * reintento a partir de `ok`/`error_codigo` (RB-CMR-05).
 */

/** Resuelve el canal efectivo de envío (config de entorno ∩ canal programado). */
export function resolverCanal(
  configCanal: RecordatorioCanal,
  canalRecordatorio: RecordatorioCanal,
): RecordatorioCanal {
  if (configCanal === RecordatorioCanal.Log) return RecordatorioCanal.Log;
  return canalRecordatorio;
}

export interface NotificationServiceOptions {
  configCanal: RecordatorioCanal;
  canales: Record<RecordatorioCanal, NotificationChannel>;
}

export class NotificationService {
  private readonly configCanal: RecordatorioCanal;
  private readonly canales: Record<RecordatorioCanal, NotificationChannel>;

  constructor(opciones: NotificationServiceOptions) {
    this.configCanal = opciones.configCanal;
    this.canales = opciones.canales;
  }

  async enviar(notificacion: Notificacion): Promise<ResultadoEnvio> {
    const canal = resolverCanal(this.configCanal, notificacion.canal);
    return this.canales[canal].enviar(notificacion);
  }
}

/**
 * Construye el NotificationService de producción a partir del entorno: un
 * EmailChannel (Resend) y un LogChannel. No exige `RESEND_API_KEY`: con
 * `NOTIFICATION_CHANNEL=log` (default) el email nunca se toca.
 */
export function crearNotificationService(
  env: Pick<Env, "NOTIFICATION_CHANNEL" | "RESEND_API_KEY" | "RESEND_FROM">,
  logger: NotificacionLogger,
): NotificationService {
  return new NotificationService({
    configCanal: env.NOTIFICATION_CHANNEL,
    canales: {
      [RecordatorioCanal.Email]: new EmailChannel({
        apiKey: env.RESEND_API_KEY,
        from: env.RESEND_FROM,
      }),
      [RecordatorioCanal.Log]: new LogChannel(logger),
    },
  });
}
