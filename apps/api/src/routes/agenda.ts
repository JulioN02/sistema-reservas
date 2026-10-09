import type { FastifyPluginAsync } from "fastify";
import type { Env } from "../config/env";
import type { Database } from "../db";
import { createAgendaController } from "../controllers/agenda";

/**
 * Rutas de agenda (T-08) — registro thin, contrato /api/v1:
 *
 * Públicas (sin sesión; tenant = DEFAULT_TENANT_SLUG):
 * - GET /api/v1/servicios          → 200 ServicioPublico[]
 * - GET /api/v1/agenda             → 200 AgendaResponse (400/422/404)
 *
 * Negocio (sesión obligatoria — se agregan en T-09):
 * - /api/v1/agenda/horarios, /api/v1/agenda/bloques, /api/v1/servicios CRUD
 */

export interface AgendaRouteOptions {
  db: Database;
  env: Env;
}

export const agendaRoutes: FastifyPluginAsync<AgendaRouteOptions> = async (
  app,
  opts,
) => {
  const controller = createAgendaController({ db: opts.db, env: opts.env });

  app.get("/api/v1/servicios", controller.listarServicios);
  app.get("/api/v1/agenda", controller.calcularAgenda);
};