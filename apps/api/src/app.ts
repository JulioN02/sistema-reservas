import Fastify, { type FastifyInstance } from "fastify";
import type { LoggerOptions } from "pino";
import type { Env } from "./config/env";
import { createCheckDb, type CheckDb } from "./db";
import { createErrorHandler, NotFoundError } from "./infra/errors";
import { buildLoggerOptions, nuevoRequestId } from "./infra/logger";
import { healthRoutes } from "./routes/health";

export interface AppDeps {
  env: Env;
  /**
   * Opciones pino (Fastify crea el logger). Inyectable para tests
   * (silent o stream en memoria); por defecto deriva de `env.LOG_LEVEL`.
   */
  loggerOptions?: LoggerOptions;
  /** Inyectable para tests; por defecto chequea la BD real (SELECT 1). */
  checkDb?: CheckDb;
}

/**
 * Construye la instancia Fastify con plugins, manejador central de errores
 * (RFC 7807) y rutas registradas. No escucha: `server.ts` se encarga del
 * arranque real.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.loggerOptions ?? buildLoggerOptions(deps.env.LOG_LEVEL),
    // request_id para correlación en logs (RNF-07)
    genReqId: () => nuevoRequestId(),
  });

  app.setErrorHandler(createErrorHandler(app.log));

  // 404 también en formato problem+json (contrato: todos los errores RFC 7807).
  app.setNotFoundHandler((request, reply) => {
    reply
      .status(404)
      .type("application/problem+json")
      .send(new NotFoundError("La ruta no existe.").toProblemJson(request.url));
  });

  app.register(healthRoutes, {
    checkDb: deps.checkDb ?? createCheckDb(deps.env.DATABASE_URL),
  });

  return app;
}