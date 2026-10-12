import type { RecordatorioCanal } from "@sistema-reservas/contracts";

/**
 * Abstracción de canal de notificación (diseño §6.1, gate 3).
 *
 * Flujo: evento de dominio → `NotificationService.enviar(Notificacion)` →
 * `NotificationChannel.enviar(msg)` → `ResultadoEnvio`. La interfaz deja el
 * seam abierto para `WhatsAppChannel` (no implementado en v1) y para canales
 * de prueba.
 */

/**
 * Datos de una notificación de recordatorio. Contenido permitido por
 * RB-CMR-06: nombre del cliente, servicio, fecha/hora local del negocio y
 * enlace de gestión. NUNCA datos de terceros (EC-05).
 */
export interface Notificacion {
  /** Canal con el que se programó el recordatorio (`recordatorios.canal`). */
  canal: RecordatorioCanal;
  /** Destino del email; `null` si el cliente no aportó email. */
  destinatario: string | null;
  /** Nombre del cliente (RB-CMR-06). */
  cliente_nombre: string;
  /** Nombre del servicio reservado. */
  servicio: string;
  /** Inicio del turno en UTC; se formatea en la zona del negocio (AD-06). */
  fecha_hora_inicio: Date;
  /** Zona horaria IANA del negocio. */
  timezone: string;
  /** Enlace público de gestión `/g/{token}` (RB-CMR-01). */
  enlace: string;
  /** Lead del recordatorio en minutos (payload §13). */
  lead_min: number;
  /** Número de intento (1-based; payload §13). */
  intento: number;
}

/** Resultado de un envío; `ok:false` expone el motivo para decidir reintentos. */
export interface ResultadoEnvio {
  ok: boolean;
  error_codigo?: string;
}

export interface NotificationChannel {
  enviar(notificacion: Notificacion): Promise<ResultadoEnvio>;
}

/** Logger mínimo requerido por los canales (compatible con pino/Fastify). */
export interface NotificacionLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
}

/** Construye el enlace público de gestión `/g/{token}` (RB-CMR-01). */
export function construirEnlace(token: string): string {
  return `/g/${token}`;
}
