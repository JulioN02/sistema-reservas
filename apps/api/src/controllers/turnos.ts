import type { FastifyReply, FastifyRequest } from "fastify";
import { EventoOrigen } from "@sistema-reservas/contracts";
import type { Env } from "../config/env";
import type { Database } from "../db";
import { parsearTurnoCrear } from "../dto/turnos";
import { resolverTenantPublico } from "../infra/tenant";
import { turnoService, type OrigenReserva } from "../services/turnoService";

/**
 * Controlador de turnos — thin (validar DTO + delegar al servicio + mapear).
 *
 * POST /api/v1/turnos (T-10, contrato §4.2 — seguridad opcional):
 * - Con sesión de negocio → tenant de la sesión, origen business (RST-S8).
 * - Sin sesión → tenant público (DEFAULT_TENANT_SLUG), origen public.
 * 201 TurnoCreado; 400/409 (alternativas)/422/500 — el contrato NO declara
 * 401 para este path (la reserva sin sesión es el flujo público).
 */

export interface TurnosControllerDeps {
  db: Database;
  env: Env;
}

export function createTurnosController(deps: TurnosControllerDeps) {
  return {
    async crearTurno(request: FastifyRequest, reply: FastifyReply) {
      const input = parsearTurnoCrear(request.body);

      let tenant_id: string;
      let origen: OrigenReserva;
      if (request.sesion !== undefined) {
        tenant_id = request.sesion.tenant_id;
        origen = EventoOrigen.Business;
      } else {
        const contexto = await resolverTenantPublico(
          deps.db,
          deps.env.DEFAULT_TENANT_SLUG,
        );
        tenant_id = contexto.tenant_id;
        origen = EventoOrigen.Public;
      }

      const creado = await turnoService.crear(deps.db, {
        tenant_id,
        input,
        origen,
        leadMin: deps.env.REMINDER_LEAD_MIN,
      });
      return reply.status(201).send(creado);
    },
  };
}