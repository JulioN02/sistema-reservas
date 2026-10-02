import type { FastifyReply, FastifyRequest } from "fastify";
import type { CheckDb } from "../db";

/**
 * Controlador de salud — thin: delega el chequeo de BD y responde el estado.
 * El chequeo se inyecta para permitir tests sin PostgreSQL real.
 */
export function createHealthController(checkDb: CheckDb) {
  return async (_request: FastifyRequest, reply: FastifyReply) => {
    const db = (await checkDb()) ? "up" : "down";
    return reply.send({ status: "ok", db });
  };
}