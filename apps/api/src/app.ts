import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { LoggerOptions } from "pino";
import type { Env } from "./config/env";
import { createCheckDb, createDb, type CheckDb, type Database } from "./db";
import { createErrorHandler, NotFoundError } from "./infra/errors";
import { buildLoggerOptions, nuevoRequestId } from "./infra/logger";
import { crearNotificationService } from "./notificaciones/notificationService";
import type { NotificationService } from "./notificaciones/notificationService";
import { authRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";
import { agendaRoutes } from "./routes/agenda";
import { metricasRoutes } from "./routes/metricas";
import { turnosRoutes } from "./routes/turnos";

export interface AppDeps {
  env: Env;
  /**
   * Opciones pino (Fastify crea el logger). Inyectable para tests
   * (silent o stream en memoria); por defecto deriva de `env.LOG_LEVEL`.
   */
  loggerOptions?: LoggerOptions;
  /** Inyectable para tests; por defecto chequea la BD real (SELECT 1). */
  checkDb?: CheckDb;
  /** Conexión Drizzle inyectable para tests; por defecto deriva de DATABASE_URL. */
  db?: Database;
  /**
   * NotificationService inyectable (RB-CRG-07); por defecto se construye del
   * entorno (`NOTIFICATION_CHANNEL`). Inyectable en tests con un espía.
   */
  notificaciones?: NotificationService;
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

  const db = deps.db ?? createDb(deps.env.DATABASE_URL);
  const notificaciones =
    deps.notificaciones ?? crearNotificationService(deps.env, app.log);

  // Sesiones opacas del operador (cookie `sid`, RB-VNG-05).
  app.register(cookie);
  // Headers de seguridad (diseño §8): CSP estricta + nosniff y resto de
  // defaults de helmet. La API solo sirve JSON, así que una CSP restrictiva
  // no rompe la SPA (que vive en otro origen). CORP `cross-origin` para que
  // la SPA configurada en CORS_ORIGIN pueda leer las respuestas.
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });
  // CORS con origen específico (nunca `*`) + credenciales (cookie de sesión).
  app.register(cors, {
    origin: deps.env.CORS_ORIGIN,
    credentials: true,
  });
  // Rate limit bajo demanda del login (5 fallos → 429/15 min, VNG-S2) y de las
  // rutas de mutación (`config.rateLimit`, diseño §8). `global: false`: el
  // límite general NO pisa el del login.
  app.register(rateLimit, { global: false });

  app.register(healthRoutes, {
    checkDb: deps.checkDb ?? createCheckDb(deps.env.DATABASE_URL),
  });
  app.register(authRoutes, { db, env: deps.env });
  app.register(agendaRoutes, { db, env: deps.env });
  app.register(turnosRoutes, { db, env: deps.env, notificaciones });
  app.register(metricasRoutes, { db });

  return app;
}