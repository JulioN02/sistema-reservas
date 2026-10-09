import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config/env";
import type { Database } from "../db";
import { parsearAgendaQuery } from "../dto/agenda";
import { NotFoundError } from "../infra/errors";
import { resolverTenantPublico } from "../infra/tenant";
import { agendaService } from "../services/agendaService";
import { tenantRepository } from "../repositories/tenantScoped";

/**
 * Controlador de agenda pública (T-08) — thin (validar DTO + delegar al
 * servicio + mapear respuesta):
 *
 * - GET /api/v1/servicios → 200 ServicioPublico[] (sin tenant_id, CA-INT-04;
 *   solo servicios activos).
 * - GET /api/v1/agenda?servicio_id&desde&hasta → 200 {zona_horaria, dias}
 *   400 query malformada · 422 rango invertido · 404 servicio desconocido.
 *
 * Sin sesión: el tenant se resuelve de DEFAULT_TENANT_SLUG (diseño §4.1,
 * RB-INT-03); nunca se expone tenant_id (CA-INT-04).
 */

export interface AgendaControllerDeps {
  db: Database;
  env: Env;
}

export function createAgendaController(deps: AgendaControllerDeps) {
  return {
    async listarServicios(request: FastifyRequest, reply: FastifyReply) {
      // T-09 añade la variante de negocio (con sesión → Servicio[]).
      const tenant = await resolverTenantPublico(
        deps.db,
        deps.env.DEFAULT_TENANT_SLUG,
      );
      const servicios = await agendaService.serviciosPublicos(
        deps.db,
        tenant.tenant_id,
      );
      return reply.send(servicios);
    },

    async calcularAgenda(request: FastifyRequest, reply: FastifyReply) {
      const query = parsearAgendaQuery(request.query);

      const contexto = await resolverTenantPublico(
        deps.db,
        deps.env.DEFAULT_TENANT_SLUG,
      );
      const tenant = await tenantRepository.porId(
        deps.db,
        contexto.tenant_id,
      );
      if (tenant === undefined) {
        throw new NotFoundError("El negocio público no está configurado.");
      }

      const dias = await agendaService.agendaPublica(deps.db, {
        tenant_id: contexto.tenant_id,
        timezone: tenant.timezone,
        servicio_id: query.servicio_id,
        desde: query.desde,
        hasta: query.hasta,
      });

      return reply.send({ zona_horaria: tenant.timezone, dias });
    },
  };
}