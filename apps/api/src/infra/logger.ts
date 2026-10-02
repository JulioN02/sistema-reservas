import { randomUUID } from "node:crypto";
import { stdTimeFunctions, type LoggerOptions } from "pino";

/**
 * Opciones de logger estructurado (RNF-07). Fastify crea el logger pino a
 * partir de estas opciones; `request_id` se genera por request en `buildApp`
 * (genReqId) y queda en todos los logs del ciclo de vida de la petición.
 */
export function buildLoggerOptions(level = "info"): LoggerOptions {
  return {
    level,
    base: undefined,
    timestamp: stdTimeFunctions.isoTime,
  };
}

export function nuevoRequestId(): string {
  return randomUUID();
}