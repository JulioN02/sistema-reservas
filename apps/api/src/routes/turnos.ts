import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Env } from "../config/env";
import type { Database } from "../db";
import { createTurnosController } from "../controllers/turnos";
import { crearRequireSession, SESION_COOKIE } from "../infra/authMiddleware";
import type { NotificationService } from "../notificaciones/notificationService";
import { authService } from "../services/authService";

/**
 * Rutas de turnos — registro thin, contrato /api/v1 (T-10/T-11/T-14):
 *
 * - POST /api/v1/turnos → 201 TurnoCreado (reserva pública o en nombre del
 *   cliente desde el negocio — RST-S8). Seguridad OPCIONAL (contrato:
 *   `security: [{}, cookieAuth]`): con cookie válida inyecta
 *   `request.sesion` (tenant del operador); sin cookie → flujo público
 *   (DEFAULT_TENANT_SLUG). Nunca 401 en este path.
 * - Enlace de gestión (token opaco): GET /turnos/{param} (token público o id
 *   de negocio — T-15), POST confirmar/cancelar/reagendar.
 * - Historial de negocio: GET /turnos (T-15, sesión obligatoria).
 * - POST /turnos/{id}/acciones (negocio, sesión obligatoria): confirmar/
 *   cancelar/completado/no_show (T-14).
 */

export interface TurnosRouteOptions {
  db: Database;
  env: Env;
  /** NotificationService inyectable (RB-CRG-07); opcional en tests. */
  notificaciones?: NotificationService;
}

/**
 * Resolución OPCIONAL de sesión (contrato dual público/negocio): si la
 * cookie es válida inyecta `request.sesion`; si no, la ruta sigue el flujo
 * público. Nunca lanza (a diferencia de `crearRequireSession`).
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

export const turnosRoutes: FastifyPluginAsync<TurnosRouteOptions> = async (
  app,
  opts,
) => {
  const controller = createTurnosController({
    db: opts.db,
    env: opts.env,
    notificaciones: opts.notificaciones,
  });
  const requireSession = crearRequireSession(opts.db);

  app.post(
    "/api/v1/turnos",
    { preHandler: sesionOpcional(opts.db) },
    controller.crearTurno,
  );
  // Historial de negocio (T-15, sesión obligatoria; 401 sin cookie — VNG-S7).
  app.get(
    "/api/v1/turnos",
    { preHandler: requireSession },
    controller.historialTurnos,
  );
  // Path compartido (T-11/T-15): Fastify no admite dos rutas con el mismo
  // patrón `/turnos/:x`, así que `/turnos/{token}` (público) y `/turnos/{id}`
  // (negocio) se resuelven en un único handler que discrimina por la forma
  // del parámetro. `sesionOpcional` inyecta la sesión si hay cookie válida.
  app.get(
    "/api/v1/turnos/:param",
    { preHandler: sesionOpcional(opts.db) },
    controller.obtenerTurno,
  );
  app.post("/api/v1/turnos/:token/confirmar", controller.confirmarTurno);
  app.post("/api/v1/turnos/:token/cancelar", controller.cancelarTurno);
  app.post("/api/v1/turnos/:token/reagendar", controller.reagendarTurno);
  // Acciones de negocio (T-14, sesión obligatoria; 401 sin cookie — VNG-S7).
  app.post(
    "/api/v1/turnos/:id/acciones",
    { preHandler: requireSession },
    controller.accionTurno,
  );
};