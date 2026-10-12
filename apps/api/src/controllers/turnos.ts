import type { FastifyReply, FastifyRequest } from "fastify";
import { EventoOrigen } from "@sistema-reservas/contracts";
import type { Env } from "../config/env";
import type { Database } from "../db";
import {
  esUuid,
  parsearAccionTurno,
  parsearHistorialQuery,
  parsearTurnoCrear,
  parsearTurnoReagendar,
} from "../dto/turnos";
import { UnauthorizedError } from "../infra/errors";
import { resolverTenantPublico } from "../infra/tenant";
import type { NotificationService } from "../notificaciones/notificationService";
import { turnoService, type OrigenReserva } from "../services/turnoService";

/**
 * Controlador de turnos — thin (validar DTO + delegar al servicio + mapear).
 *
 * POST /api/v1/turnos (T-10, contrato §4.2 — seguridad opcional):
 * - Con sesión de negocio → tenant de la sesión, origen business (RST-S8).
 * - Sin sesión → tenant público (DEFAULT_TENANT_SLUG), origen public.
 * 201 TurnoCreado; 400/409 (alternativas)/422/500 — el contrato NO declara
 * 401 para este path (la reserva sin sesión es el flujo público).
 *
 * Enlace de gestión (T-11/T-14): GET /turnos/{param} resuelve token (público)
 * o id (negocio, T-15) según la forma del parámetro; POST confirmar/cancelar/
 * reagendar (público, token opaco). Negocio: GET /turnos (historial, T-15) y
 * POST /turnos/{id}/acciones (sesión obligatoria).
 */

export interface TurnosControllerDeps {
  db: Database;
  env: Env;
  /** NotificationService inyectable (RB-CRG-07); opcional en tests. */
  notificaciones?: NotificationService;
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

    /**
     * GET /api/v1/turnos/{param} — path compartido por dos contratos (Fastify
     * no admite dos rutas con el mismo patrón `/turnos/:x`):
     * - `{token}` público (T-11): el token deriva turno → tenant implícito
     *   (RB-INT-02); 404/410 sin revelar datos (CMR-S3); nunca expone tenant_id.
     * - `{id}` negocio (T-15): sesión obligatoria (401 sin cookie, VNG-S7);
     *   detalle scoped al tenant, 404 si es de otro tenant (INT-S1).
     * El discriminante es la forma del parámetro: un token de gestión es
     * base64url de 43 caracteres y nunca coincide con un UUID.
     */
    async obtenerTurno(request: FastifyRequest, reply: FastifyReply) {
      const { param } = request.params as { param: string };
      if (esUuid(param)) {
        // Contrato /turnos/{id}: sesión obligatoria → 401 sin cookie (VNG-S7).
        if (request.sesion === undefined) {
          throw new UnauthorizedError("Se requiere una sesión válida.");
        }
        const detalle = await turnoService.detalle(
          deps.db,
          request.sesion.tenant_id,
          param,
        );
        return reply.status(200).send(detalle);
      }
      // Contrato /turnos/{token}: enlace público de gestión.
      const gestion = await turnoService.obtenerPorToken(deps.db, param);
      return reply.status(200).send(gestion);
    },

    /**
     * GET /api/v1/turnos (T-15, negocio, VNG-02/VNG-S6): historial filtrable
     * por estado y rango de fechas, orden desc. Sesión obligatoria (401).
     */
    async historialTurnos(request: FastifyRequest, reply: FastifyReply) {
      if (request.sesion === undefined) {
        throw new UnauthorizedError("Se requiere una sesión válida.");
      }
      const filtros = parsearHistorialQuery(request.query);
      const turnos = await turnoService.historial(
        deps.db,
        request.sesion.tenant_id,
        filtros,
      );
      return reply.status(200).send(turnos);
    },

    /**
     * POST /api/v1/turnos/{token}/confirmar (T-11) → 200 idempotente
     * {turno_id, estado} (RB-CMR-02, CA-CMR-01); terminal/expirado → 410.
     */
    async confirmarTurno(request: FastifyRequest, reply: FastifyReply) {
      const { token } = request.params as { token: string };
      const resultado = await turnoService.confirmar(deps.db, token);
      return reply.status(200).send(resultado);
    },

    /**
     * POST /api/v1/turnos/{token}/cancelar (T-14) → 200 idempotente
     * {turno_id, estado} (RB-CRG-08); fuera de gracia → 403 con el canal de
     * contacto del negocio (RB-CRG-02, CA-CRG-02).
     */
    async cancelarTurno(request: FastifyRequest, reply: FastifyReply) {
      const { token } = request.params as { token: string };
      const resultado = await turnoService.cancelar(deps.db, token, {
        notificaciones: deps.notificaciones,
      });
      return reply.status(200).send(resultado);
    },

    /**
     * POST /api/v1/turnos/{token}/reagendar (T-14) → 200 {turno_id, estado,
     * fecha_hora_inicio, fecha_hora_fin} (RB-CRG-04); ocupado → 409 con
     * alternativas (CRG-S5).
     */
    async reagendarTurno(request: FastifyRequest, reply: FastifyReply) {
      const { token } = request.params as { token: string };
      const input = parsearTurnoReagendar(request.body);
      const resultado = await turnoService.reagendar(deps.db, token, input, {
        notificaciones: deps.notificaciones,
      });
      return reply.status(200).send(resultado);
    },

    /**
     * POST /api/v1/turnos/{id}/acciones (T-14, negocio) → 200 {turno_id,
     * estado}. Sesión obligatoria (tenant del operador); motivo obligatorio
     * para cancelar (422, CA-CRG-04); terminal → 409 (EC-12).
     */
    async accionTurno(request: FastifyRequest, reply: FastifyReply) {
      const { id } = request.params as { id: string };
      if (request.sesion === undefined) {
        throw new UnauthorizedError("Se requiere una sesión válida.");
      }
      const input = parsearAccionTurno(request.body);
      const resultado = await turnoService.accion(
        deps.db,
        request.sesion.tenant_id,
        id,
        input,
        { notificaciones: deps.notificaciones },
      );
      return reply.status(200).send(resultado);
    },
  };
}