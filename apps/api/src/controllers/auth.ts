import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config/env";
import type { Database } from "../db";
import { parsearCredenciales } from "../dto/auth";
import { SESION_COOKIE } from "../infra/authMiddleware";
import {
  TooManyRequestsError,
  UnauthorizedError,
} from "../infra/errors";
import { resolverTenantPublico } from "../infra/tenant";
import { authService } from "../services/authService";

/**
 * Controlador de auth — thin (validar DTO + delegar al servicio + mapear):
 *
 * - POST /api/v1/auth/login  → 200 {operador_id,email,nombre} + cookie `sid`
 *   401 credenciales inválidas · 422 DTO · 429 lockout (VNG-S2).
 * - POST /api/v1/auth/logout → 204 (revoca la sesión) · 401 sin sesión.
 * - GET  /api/v1/auth/me     → 200 OperadorSesion (sin secrets) · 401.
 *
 * El rate limit del login solo cuenta intentos FALLIDOS (peek sin consumir
 * + consumo al fallar): 5 fallos → 429 y bloqueo de 15 min (diseño §8).
 */

/** Función devuelta por `fastify.createRateLimit` (plug-in @fastify/rate-limit). */
export type VerificadorLimite = ReturnType<FastifyInstance["createRateLimit"]>;

export interface AuthControllerDeps {
  db: Database;
  env: Env;
  verificarLimite: VerificadorLimite;
}

export function createAuthController(deps: AuthControllerDeps) {
  return {
    async login(request: FastifyRequest, reply: FastifyReply) {
      const credenciales = parsearCredenciales(request.body);
      // Login es un endpoint sin sesión: tenant = DEFAULT_TENANT_SLUG (diseño §4.1).
      const tenant = await resolverTenantPublico(
        deps.db,
        deps.env.DEFAULT_TENANT_SLUG,
      );

      // Peek sin consumir: si ya no quedan intentos → 429 (bloqueo 15 min).
      const estado = await deps.verificarLimite(request, { increment: false });
      if (!estado.isAllowed && estado.remaining <= 0) {
        throw new TooManyRequestsError(
          "Demasiados intentos fallidos. Reintente en 15 minutos.",
        );
      }

      const sesion = await authService.login(deps.db, credenciales, {
        tenantId: tenant.tenant_id,
        ttlDays: deps.env.SESSION_TTL_DAYS,
      });
      if (sesion === null) {
        // Consume el intento SOLO si el login falló (VNG-S2).
        await deps.verificarLimite(request);
        throw new UnauthorizedError("Credenciales inválidas.");
      }

      return reply
        .setCookie(SESION_COOKIE, sesion.token, {
          httpOnly: true,
          sameSite: "lax",
          secure: deps.env.COOKIE_SECURE,
          path: "/",
          maxAge: deps.env.SESSION_TTL_DAYS * 24 * 60 * 60,
        })
        .status(200)
        .send(sesion.operador);
    },

    async logout(request: FastifyRequest, reply: FastifyReply) {
      const token = request.cookies[SESION_COOKIE];
      if (token === undefined || token === "") {
        throw new UnauthorizedError("Se requiere una sesión válida.");
      }
      await authService.logout(deps.db, token);
      return reply.status(204).send();
    },

    me(request: FastifyRequest, reply: FastifyReply) {
      const sesion = request.sesion;
      if (sesion === undefined) {
        throw new UnauthorizedError("Se requiere una sesión válida.");
      }
      return reply.send(sesion.operador);
    },
  };
}