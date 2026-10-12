import { formatInTimeZone } from "date-fns-tz";
import { Resend } from "resend";
import type {
  Notificacion,
  NotificationChannel,
  ResultadoEnvio,
} from "./channel";

/**
 * EmailChannel (diseño §6.1): email transaccional vía SDK de Resend.
 *
 * Contenido RB-CMR-06 (EC-05): SOLO nombre del cliente, servicio, fecha/hora
 * local del negocio (zona IANA del tenant, AD-06) y enlace de gestión. NUNCA
 * datos de terceros. El contenido se construye con `construirEmail` (función
 * pura, unit-testable) para no acoplar los tests al SDK.
 *
 * Fallo grácil (RB-CMR-05): si faltan `RESEND_API_KEY`/`RESEND_FROM` el canal
 * devuelve `{ ok:false, error_codigo:"config_ausente" }` sin lanzar; el
 * scheduler decide la reprogramación. El enlace firmado sigue siendo el
 * fallback (CA-CMR-04).
 */

export interface EmailChannelConfig {
  apiKey?: string;
  from?: string;
}

export interface EmailContenido {
  subject: string;
  text: string;
}

/** Construye el asunto y el cuerpo del email (RB-CMR-06, neutral). */
export function construirEmail(notificacion: Notificacion): EmailContenido {
  const fechaLocal = formatInTimeZone(
    notificacion.fecha_hora_inicio,
    notificacion.timezone,
    "yyyy-MM-dd HH:mm",
  );
  const subject = `Recordatorio de tu turno: ${notificacion.servicio}`;
  const text =
    `Hola ${notificacion.cliente_nombre}:\n\n` +
    `Te recordamos tu turno de ${notificacion.servicio} para el ` +
    `${fechaLocal} (hora local del negocio).\n\n` +
    `Puedes gestionar tu turno en: ${notificacion.enlace}\n`;
  return { subject, text };
}

export class EmailChannel implements NotificationChannel {
  private readonly resend: Resend | null;
  private readonly from: string | null;

  constructor(config: EmailChannelConfig) {
    this.from = config.from ?? null;
    this.resend =
      config.apiKey !== undefined && config.from !== undefined
        ? new Resend(config.apiKey)
        : null;
  }

  async enviar(notificacion: Notificacion): Promise<ResultadoEnvio> {
    if (this.resend === null || this.from === null) {
      return { ok: false, error_codigo: "config_ausente" };
    }
    if (notificacion.destinatario === null) {
      return { ok: false, error_codigo: "sin_destinatario" };
    }

    const { subject, text } = construirEmail(notificacion);
    try {
      const { error } = await this.resend.emails.send({
        from: this.from,
        to: notificacion.destinatario,
        subject,
        text,
      });
      if (error) {
        return { ok: false, error_codigo: error.name ?? "resend_error" };
      }
      return { ok: true };
    } catch {
      return { ok: false, error_codigo: "error_red" };
    }
  }
}
