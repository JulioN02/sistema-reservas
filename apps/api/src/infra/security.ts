import type { FastifyRequest } from "fastify";
import { BadRequestError } from "./errors";

/**
 * Baseline de seguridad (T-18, diseño §8). Concentra los valores de los
 * controles que aplican a nivel de ruta, para no repetirlos en cada registro:
 *
 * - Rate limit GENERAL de mutaciones por IP (POST /turnos, enlaces de gestión,
 *   acciones de negocio y CRUD de agenda). El login conserva su propio límite
 *   (5 fallos → 429/15 min, VNG-S2) creado con `createRateLimit` en auth.ts:
 *   los límites por ruta de acá NO lo pisan (el plugin se registra con
 *   `global: false` y solo las rutas de mutación declaran `config.rateLimit`).
 * - Guard CSRF: las mutaciones exigen `Content-Type: application/json`.
 */

/**
 * Máximo de mutaciones por IP y ventana. Holgado para el uso legítimo del
 * negocio (cargar la agenda a mano) y suficiente para frenar abuso automatizado
 * sobre endpoints que crean/modifican recursos.
 */
export const MUTACION_MAX = 60;
/** Ventana del límite general de mutaciones: 1 minuto. */
export const MUTACION_VENTANA_MS = 60_000;

/**
 * Config de `@fastify/rate-limit` a nivel de ruta (`config.rateLimit`).
 * Estructuralmente compatible con `RateLimitOptions` del plugin.
 */
export const RATE_LIMIT_MUTACION = {
  max: MUTACION_MAX,
  timeWindow: MUTACION_VENTANA_MS,
} as const;

/**
 * Guard CSRF (diseño §8): una mutación CON CUERPO debe viajar como JSON. Un
 * formulario HTML cross-site solo puede emitir content types *safelisted* por
 * CORS (`application/x-www-form-urlencoded`, `multipart/form-data`,
 * `text/plain`), nunca `application/json`; exigirlo bloquea el vector CSRF
 * simple. Combinado con la cookie `SameSite=Lax` (T-07), el riesgo residual
 * queda bajo.
 *
 * Las mutaciones SIN cuerpo (p. ej. POST /turnos/{token}/confirmar, cuya
 * operación va en la URL/token) no son alcanzables por un formulario con datos
 * y quedan fuera del guard: la capacidad es el propio token opaco (RB-CMR-01).
 *
 * Se aplica como `preHandler` en rutas POST/PUT/PATCH. Un content type distinto
 * con cuerpo → 400 `solicitud-invalida` (problem+json).
 *
 * Nota: se declara `async` a propósito. En Fastify 5 un hook SÍNCRONO que
 * retorna (sin lanzar) dentro de un array `preHandler` deja la request colgada;
 * un hook async resuelto continúa normalmente y un throw se propaga igual.
 */
export async function requerirJson(request: FastifyRequest): Promise<void> {
  const contentLength = request.headers["content-length"];
  const tieneCuerpo =
    (contentLength !== undefined && contentLength !== "0") ||
    request.headers["transfer-encoding"] !== undefined;
  if (!tieneCuerpo) return;

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    throw new BadRequestError(
      "Se requiere Content-Type: application/json en las mutaciones.",
    );
  }
}
