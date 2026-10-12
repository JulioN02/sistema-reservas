import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Env } from "../config/env";
import type { Database } from "../db";
import { createAgendaController } from "../controllers/agenda";
import {
  crearRequireSession,
  SESION_COOKIE,
} from "../infra/authMiddleware";
import { RATE_LIMIT_MUTACION, requerirJson } from "../infra/security";
import { authService } from "../services/authService";

/**
 * Rutas de agenda — registro thin, contrato /api/v1:
 *
 * Públicas (T-08, sin sesión; tenant = DEFAULT_TENANT_SLUG):
 * - GET /api/v1/servicios → 200 ServicioPublico[] (con sesión: Servicio[]).
 * - GET /api/v1/agenda    → 200 AgendaResponse (400/422/404).
 *
 * Negocio (T-09, sesión obligatoria — 401 sin cookie):
 * - GET /api/v1/agenda/dia (T-15): turnos del día local del negocio.
 * - GET/POST/PUT/DELETE /api/v1/agenda/horarios (409 solapamiento).
 * - GET/POST/DELETE     /api/v1/agenda/bloques (409 pisa turnos).
 * - POST/PUT/DELETE     /api/v1/servicios + PATCH /servicios/{id}/parametros.
 */

export interface AgendaRouteOptions {
  db: Database;
  env: Env;
}

/**
 * Resolución OPCIONAL de sesión para GET /servicios (contrato dual público/
 * negocio): si la cookie es válida inyecta `request.sesion`; si no, la ruta
 * sigue el flujo público. Nunca lanza (a diferencia de `crearRequireSession`).
 */
function sesionOpcional(db: Database) {
  return async function resolver(request: FastifyRequest): Promise<void> {
    const token = request.cookies[SESION_COOKIE];
    if (token === undefined || token === "") return;
    const sesion = await authService.sesionPorToken(db, token);
    if (sesion !== null) {
      request.sesion = sesion;
    }
  };
}

export const agendaRoutes: FastifyPluginAsync<AgendaRouteOptions> = async (
  app,
  opts,
) => {
  const controller = createAgendaController({ db: opts.db, env: opts.env });
  const requireSession = crearRequireSession(opts.db);

  // Público
  app.get(
    "/api/v1/servicios",
    { preHandler: sesionOpcional(opts.db) },
    controller.listarServicios,
  );
  app.get("/api/v1/agenda", controller.calcularAgenda);
  // Vista del día del negocio (T-15, sesión obligatoria; 401 sin cookie).
  app.get(
    "/api/v1/agenda/dia",
    { preHandler: requireSession },
    controller.agendaDelDia,
  );

  // Mutaciones de negocio (T-18, diseño §8): rate limit general por IP + guard
  // CSRF (Content-Type: application/json obligatorio). DELETE no lleva cuerpo
  // ni es alcanzable desde un formulario cross-site → solo rate limit.
  const mutacionJson = () => ({
    preHandler: [requireSession, requerirJson],
    config: { rateLimit: RATE_LIMIT_MUTACION },
  });
  const mutacionSinCuerpo = () => ({
    preHandler: requireSession,
    config: { rateLimit: RATE_LIMIT_MUTACION },
  });

  // Negocio — horarios recurrentes
  app.get(
    "/api/v1/agenda/horarios",
    { preHandler: requireSession },
    controller.listarHorarios,
  );
  app.post(
    "/api/v1/agenda/horarios",
    mutacionJson(),
    controller.crearHorario,
  );
  app.put(
    "/api/v1/agenda/horarios/:id",
    mutacionJson(),
    controller.actualizarHorario,
  );
  app.delete(
    "/api/v1/agenda/horarios/:id",
    mutacionSinCuerpo(),
    controller.eliminarHorario,
  );

  // Negocio — bloques de indisponibilidad
  app.get(
    "/api/v1/agenda/bloques",
    { preHandler: requireSession },
    controller.listarBloques,
  );
  app.post(
    "/api/v1/agenda/bloques",
    mutacionJson(),
    controller.crearBloque,
  );
  app.delete(
    "/api/v1/agenda/bloques/:id",
    mutacionSinCuerpo(),
    controller.eliminarBloque,
  );

  // Negocio — servicios (CRUD + parámetros)
  app.post(
    "/api/v1/servicios",
    mutacionJson(),
    controller.crearServicio,
  );
  app.put(
    "/api/v1/servicios/:id",
    mutacionJson(),
    controller.actualizarServicio,
  );
  app.delete(
    "/api/v1/servicios/:id",
    mutacionSinCuerpo(),
    controller.eliminarServicio,
  );
  app.patch(
    "/api/v1/servicios/:id/parametros",
    mutacionJson(),
    controller.actualizarParametrosServicio,
  );
};