import type { FastifyRequest } from "fastify";
import type { Database } from "../db";
import type { SesionActiva } from "../dto/auth";
import { UnauthorizedError } from "./errors";
import { authService } from "../services/authService";

/**
 * Middleware reutilizable de sesión para rutas de negocio (T-07, VNG-S7):
 * una ruta protegida responde 401 sin cookie `sid` válida. Inyecta la
 * sesión activa en `request.sesion` (identidad + tenant_id del operador)
 * para que servicios/repositorios de negocio aislen por tenant (RB-INT-01).
 */

/** Nombre de la cookie de sesión opaca (contrato: cookieAuth, name: sid). */
export const SESION_COOKIE = "sid";

declare module "fastify" {
  interface FastifyRequest {
    /** Sesión activa del operador, resuelta por `crearRequireSession`. */
    sesion?: SesionActiva;
  }
}

/** Crea el preHandler que exige sesión válida (401 sin cookie o inválida). */
export function crearRequireSession(db: Database) {
  return async function requireSession(
    request: FastifyRequest,
  ): Promise<void> {
    const token = request.cookies[SESION_COOKIE];
    if (token === undefined || token === "") {
      throw new UnauthorizedError("Se requiere una sesión válida.");
    }
    const sesion = await authService.sesionPorToken(db, token);
    if (sesion === null) {
      throw new UnauthorizedError("La sesión es inválida o expiró.");
    }
    request.sesion = sesion;
  };
}