import type { EventoOrigen, EventoTipo } from "@sistema-reservas/contracts";
import type { Database } from "../db";
import type { EventoMetrica } from "../db/schema";
import { metricasRepository } from "../repositories/metricasRepository";

/**
 * EventoService (T-16) — ÚNICO camino de escritura de eventos de métricas
 * (diseño §7.1). Todo cambio de estado del turno (reserva, confirmación,
 * cancelación, reagenda, no-show, completado, recordatorios) registra su
 * evento por acá, SIEMPRE dentro de la misma transacción del cambio de estado
 * (CA-MTE-01: exactamente 1 evento por transición; RB-MTE-01: `evento_id` PK
 * anti-duplicado).
 *
 * Los payloads siguen spec §13 y NO contienen PII (RB-MTE-04, CA-MTE-03):
 * solo ids, instantes, enums y motivo.
 */

export interface EventoInput {
  tenant_id: string;
  turno_id: string;
  /** Correlación (RNF-07): ids del cliente/servicio, nunca sus datos. */
  cliente_id?: string | null;
  servicio_id?: string | null;
  tipo: EventoTipo;
  payload: Record<string, unknown>;
  origen: EventoOrigen;
}

export const eventoService = {
  /**
   * Registra UN evento de métricas en `db` (que puede ser la transacción en
   * curso). Reenvía al repositorio parametrizado (único path de inserción).
   */
  async registrar(db: Database, datos: EventoInput): Promise<EventoMetrica> {
    return metricasRepository.insertarEvento(db, {
      tenant_id: datos.tenant_id,
      turno_id: datos.turno_id,
      cliente_id: datos.cliente_id ?? null,
      servicio_id: datos.servicio_id ?? null,
      tipo: datos.tipo,
      payload: datos.payload,
      origen: datos.origen,
    });
  },
};
