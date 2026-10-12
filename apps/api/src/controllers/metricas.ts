import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db";
import { UnauthorizedError } from "../infra/errors";
import { metricasService } from "../services/metricasService";

/**
 * Controlador de métricas — thin (sesión → tenant → delegar al servicio).
 *
 * GET /api/v1/metricas/resumen (T-16, contrato /metricas/resumen): sesión
 * obligatoria (401 sin cookie — VNG-S7); el tenant del operador define la zona
 * horaria de las ventanas ISO (RB-MTE-03).
 */

export interface MetricasControllerDeps {
  db: Database;
}

export function createMetricasController(deps: MetricasControllerDeps) {
  return {
    async resumenMetricas(request: FastifyRequest, reply: FastifyReply) {
      if (request.sesion === undefined) {
        throw new UnauthorizedError("Se requiere una sesión válida.");
      }
      const resumen = await metricasService.resumen(deps.db, {
        tenant_id: request.sesion.tenant_id,
      });
      return reply.status(200).send(resumen);
    },
  };
}
