import type { Database } from "../db";
import type { Cliente } from "../db/schema";
import { MARCA_ELIMINADO, turnoRepository } from "../repositories/turnoRepository";

/**
 * PrivacyService (T-18, PRV-01..04) — punto único de las operaciones de
 * privacidad del negocio sobre los datos del cliente.
 *
 * PRV-02 (derecho de baja): a pedido del negocio, se anonimiza la PII del
 * cliente (`nombre` → "[eliminado]"; email/teléfono en la medida que los
 * constraints lo permiten — ver la nota de estrategia en el repositorio).
 * Se CONSERVAN `cliente_id`, los turnos y los eventos: retención sin PII
 * (R-D7). Es una operación interna (el diseño §8 no define un endpoint
 * público), por eso se expone como servicio testeado por integración.
 */

export { MARCA_ELIMINADO };

export const privacyService = {
  /**
   * Anonimiza la PII del cliente dentro de su tenant (RB-INT-01). Devuelve la
   * fila anonimizada o `undefined` si el cliente no existe en ese tenant
   * (INT-S1: no filtra datos de otros tenants).
   */
  anonimizarCliente(
    db: Database,
    tenantId: string,
    clienteId: string,
  ): Promise<Cliente | undefined> {
    return turnoRepository.anonimizarCliente(db, tenantId, clienteId);
  },
};
