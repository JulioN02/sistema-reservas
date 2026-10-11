import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config/env";
import type { Database } from "../db";
import type { SesionActiva } from "../dto/auth";
import {
  parsearAgendaQuery,
  parsearBloqueInput,
  parsearHorarioInput,
  parsearId,
  parsearParametrosServicio,
  parsearServicioInput,
} from "../dto/agenda";
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../infra/errors";
import { resolverTenantPublico } from "../infra/tenant";
import { agendaService } from "../services/agendaService";
import { tenantRepository } from "../repositories/tenantScoped";

/**
 * Controlador de agenda — thin (validar DTO + delegar al servicio + mapear).
 *
 * Público (T-08, sin sesión; tenant = DEFAULT_TENANT_SLUG):
 * - GET /api/v1/servicios → 200 ServicioPublico[] (sin tenant_id, CA-INT-04).
 * - GET /api/v1/agenda → 200 {zona_horaria, dias} (400/422/404).
 *
 * Negocio (T-09, sesión obligatoria — 401 sin cookie, RB-INT-03):
 * - GET/POST/PUT/DELETE /api/v1/agenda/horarios (409 solapamiento, RB-AGD-01).
 * - GET/POST/DELETE /api/v1/agenda/bloques (409 pisa turnos, AGD-S7).
 * - GET/POST/PUT/DELETE /api/v1/servicios + PATCH /servicios/{id}/parametros.
 * - GET /api/v1/servicios con sesión → 200 Servicio[] (parámetros).
 */

export interface AgendaControllerDeps {
  db: Database;
  env: Env;
}

/** Sesión del request (las rutas negocio exigen preHandler requireSession). */
function sesionDe(request: FastifyRequest): SesionActiva {
  if (request.sesion === undefined) {
    throw new UnauthorizedError("Se requiere una sesión válida.");
  }
  return request.sesion;
}

/** Extrae y valida el path param `id` de las rutas /{id}. */
function idDeParams(params: unknown): string {
  if (typeof params !== "object" || params === null || !("id" in params)) {
    throw new ValidationError([
      { campo: "id", mensaje: "El identificador es obligatorio." },
    ]);
  }
  return parsearId((params as { id?: unknown }).id);
}

export function createAgendaController(deps: AgendaControllerDeps) {
  return {
    async listarServicios(request: FastifyRequest, reply: FastifyReply) {
      // Con sesión de negocio → Servicio[] (parámetros); sin sesión →
      // ServicioPublico[] (contrato /servicios dual).
      if (request.sesion !== undefined) {
        const servicios = await agendaService.listarServicios(
          deps.db,
          request.sesion.tenant_id,
        );
        return reply.send(servicios);
      }
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

    // --- Gestión de agenda del negocio (T-09) ---

    async listarHorarios(request: FastifyRequest, reply: FastifyReply) {
      const sesion = sesionDe(request);
      return reply.send(
        await agendaService.listarHorarios(deps.db, sesion.tenant_id),
      );
    },

    async crearHorario(request: FastifyRequest, reply: FastifyReply) {
      const sesion = sesionDe(request);
      const input = parsearHorarioInput(request.body);
      const horario = await agendaService.crearHorario(
        deps.db,
        sesion.tenant_id,
        input,
      );
      return reply.status(201).send(horario);
    },

    async actualizarHorario(request: FastifyRequest, reply: FastifyReply) {
      const sesion = sesionDe(request);
      const id = idDeParams(request.params);
      const input = parsearHorarioInput(request.body);
      return reply.send(
        await agendaService.actualizarHorario(deps.db, sesion.tenant_id, id, input),
      );
    },

    async eliminarHorario(request: FastifyRequest, reply: FastifyReply) {
      const sesion = sesionDe(request);
      const id = idDeParams(request.params);
      await agendaService.eliminarHorario(deps.db, sesion.tenant_id, id);
      return reply.status(204).send();
    },

    async listarBloques(request: FastifyRequest, reply: FastifyReply) {
      const sesion = sesionDe(request);
      return reply.send(
        await agendaService.listarBloques(deps.db, sesion.tenant_id),
      );
    },

    async crearBloque(request: FastifyRequest, reply: FastifyReply) {
      const sesion = sesionDe(request);
      const input = parsearBloqueInput(request.body);
      const bloque = await agendaService.crearBloque(
        deps.db,
        sesion.tenant_id,
        input,
      );
      return reply.status(201).send(bloque);
    },

    async eliminarBloque(request: FastifyRequest, reply: FastifyReply) {
      const sesion = sesionDe(request);
      const id = idDeParams(request.params);
      await agendaService.eliminarBloque(deps.db, sesion.tenant_id, id);
      return reply.status(204).send();
    },

    async crearServicio(request: FastifyRequest, reply: FastifyReply) {
      const sesion = sesionDe(request);
      const input = parsearServicioInput(request.body);
      const servicio = await agendaService.crearServicio(
        deps.db,
        sesion.tenant_id,
        input,
      );
      return reply.status(201).send(servicio);
    },

    async actualizarServicio(request: FastifyRequest, reply: FastifyReply) {
      const sesion = sesionDe(request);
      const id = idDeParams(request.params);
      const input = parsearServicioInput(request.body);
      return reply.send(
        await agendaService.actualizarServicio(deps.db, sesion.tenant_id, id, input),
      );
    },

    async eliminarServicio(request: FastifyRequest, reply: FastifyReply) {
      const sesion = sesionDe(request);
      const id = idDeParams(request.params);
      await agendaService.eliminarServicio(deps.db, sesion.tenant_id, id);
      return reply.status(204).send();
    },

    async actualizarParametrosServicio(
      request: FastifyRequest,
      reply: FastifyReply,
    ) {
      const sesion = sesionDe(request);
      const id = idDeParams(request.params);
      const input = parsearParametrosServicio(request.body);
      return reply.send(
        await agendaService.actualizarParametrosServicio(
          deps.db,
          sesion.tenant_id,
          id,
          input,
        ),
      );
    },
  };
}