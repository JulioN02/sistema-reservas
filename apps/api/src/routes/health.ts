import type { FastifyPluginAsync } from "fastify";
import type { CheckDb } from "../db";
import { createHealthController } from "../controllers/health";

export interface HealthRouteOptions {
  checkDb: CheckDb;
}

/** GET /api/v1/health — estado de salud del servicio. */
export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (
  app,
  opts,
) => {
  const controller = createHealthController(opts.checkDb);
  app.get("/api/v1/health", controller);
};