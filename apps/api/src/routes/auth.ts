import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Env } from "../config/env";
import type { Database } from "../db";
import { createAuthController } from "../controllers/auth";
import { crearRequireSession } from "../infra/authMiddleware";

/**
 * Rutas de auth (T-07) — registro thin, contrato /api/v1:
 *
 * - POST /api/v1/auth/login  → 200 + cookie `sid`
 * - POST /api/v1/auth/logout → 204 (sesión obligatoria)
 * - GET  /api/v1/auth/me     → 200 (sesión obligatoria)
 *
 * El rate limit del login (5 fallos → 429/15 min, VNG-S2) se crea acá con
 * `createRateLimit` (plug-in registrado en app.ts con `global: false`).
 */

export interface AuthRouteOptions {
  db: Database;
  env: Env;
}

/** Intentos fallidos permitidos por ventana antes del bloqueo (VNG-S2). */
export const LOGIN_MAX_INTENTOS = 5;
/** Ventana del contador de login (VNG-S2): 15 minutos. */
export const LOGIN_VENTANA_BLOQUEO_MS = 15 * 60_000;

/**
 * Clave del contador: IP + email normalizado. Un atacante que rote IPs no
 * agota el lock de la cuenta y un tercero no bloquea a otros operadores
 * desde un origen distinto.
 */
function claveDeIntento(request: FastifyRequest): string {
  const cuerpo: unknown = request.body;
  let email = "";
  if (typeof cuerpo === "object" && cuerpo !== null && "email" in cuerpo) {
    const posible = (cuerpo as { email?: unknown }).email;
    if (typeof posible === "string") {
      email = posible.trim().toLowerCase();
    }
  }
  return `login:${request.ip}:${email}`;
}

export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (
  app,
  opts,
) => {
  const verificarLimite = app.createRateLimit({
    max: LOGIN_MAX_INTENTOS,
    timeWindow: LOGIN_VENTANA_BLOQUEO_MS,
    keyGenerator: claveDeIntento,
  });
  const requireSession = crearRequireSession(opts.db);
  const controller = createAuthController({
    db: opts.db,
    env: opts.env,
    verificarLimite,
  });

  app.post("/api/v1/auth/login", controller.login);
  app.post(
    "/api/v1/auth/logout",
    { preHandler: requireSession },
    controller.logout,
  );
  app.get("/api/v1/auth/me", { preHandler: requireSession }, controller.me);
};