import type {
  Notificacion,
  NotificationChannel,
  NotificacionLogger,
  ResultadoEnvio,
} from "./channel";
import { construirEmail } from "./emailChannel";

/**
 * LogChannel (diseño §6.1): canal de desarrollo/demo. Registra en el log el
 * email que se habría enviado (mismo contenido que EmailChannel) y devuelve
 * éxito. Es el canal por defecto hasta que exista `RESEND_API_KEY`
 * (`NOTIFICATION_CHANNEL=log`), de modo que el sistema funciona sin proveedor.
 */
export class LogChannel implements NotificationChannel {
  constructor(private readonly logger: NotificacionLogger) {}

  async enviar(notificacion: Notificacion): Promise<ResultadoEnvio> {
    const { subject, text } = construirEmail(notificacion);
    this.logger.info(
      {
        channel: "log",
        to: notificacion.destinatario,
        subject,
        body: text,
        enlace: notificacion.enlace,
      },
      "notification dispatched via log channel",
    );
    return { ok: true };
  }
}
