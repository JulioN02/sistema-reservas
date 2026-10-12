import type { FastifyPluginAsync } from "fastify";
import type { Database } from "../db";
import { createMetricasController } from "../controllers/metricas";
import { crearRequireSession } from "../infra/authMiddleware";

/**
 * Rutas de métricas — registro thin, contrato /api/v1 (T-16):
 *
 * - GET /api/v1/metricas/resumen (sesión obligatoria; 401 sin cookie —
 *   VNG-S7) → 200 MetricasResumen con los 4 KPIs del negocio (A9).
 */

export interface MetricasRouteOptions {
  db: Database;
}

export const metricasRoutes: FastifyPluginAsync<MetricasRouteOptions> = async (
  app,
  opts,
) => {
  const controller = createMetricasController({ db: opts.db });
  const requireSession = crearRequireSession(opts.db);

  app.get(
    "/api/v1/metricas/resumen",
    { preHandler: requireSession },
    controller.resumenMetricas,
  );
};
