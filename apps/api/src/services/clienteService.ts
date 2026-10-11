import type { Database } from "../db";
import type { Cliente } from "../db/schema";
import { turnoRepository } from "../repositories/turnoRepository";

/**
 * ClienteService (T-10) — deduplicación soft de clientes (RB-RST-06, EC-16):
 *
 * - Búsqueda por email normalizado (trim + lowercase) o teléfono exacto
 *   dentro del tenant.
 * - Si existe → se reutiliza (nunca bloquea la reserva) y se refrescan los
 *   canales de contacto + consentimiento (PRV-01).
 * - Si no → se crea con `consentimiento = true` (el DTO ya exigió el
 *   consentimiento explícito del cliente — CA-RST-03/04 semantics).
 *
 * El upsert se ejecuta SIEMPRE dentro de la transacción del claim (mutex
 * del tenant), por lo que dos reservas simultáneas del mismo cliente no
 * pueden duplicar el registro.
 */

/** Normaliza el email para dedup: trim + lowercase (única forma canónica). */
export function normalizarEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) return null;
  const normalizado = email.trim().toLowerCase();
  return normalizado === "" ? null : normalizado;
}

/** Normaliza el teléfono para dedup: trim. */
export function normalizarTelefono(
  telefono: string | null | undefined,
): string | null {
  if (telefono === null || telefono === undefined) return null;
  const normalizado = telefono.trim();
  return normalizado === "" ? null : normalizado;
}

export interface DatosClienteReserva {
  nombre: string;
  email?: string | null;
  telefono?: string | null;
}

export const clienteService = {
  /**
   * Obtiene o crea el cliente del tenant (dedup soft por email/teléfono).
   * Devuelve la fila completa (id + canales) para el recordatorio.
   */
  async obtenerOCrear(
    db: Database,
    tenantId: string,
    datos: DatosClienteReserva,
  ): Promise<Cliente> {
    const email = normalizarEmail(datos.email);
    const telefono = normalizarTelefono(datos.telefono);

    const existente = await turnoRepository.clientePorCanal(
      db,
      tenantId,
      email,
      telefono,
    );
    if (existente !== undefined) {
      // Reutiliza el registro: suma los canales nuevos sin borrar los previos.
      return turnoRepository.actualizarDatosCliente(db, tenantId, existente.id, {
        nombre: datos.nombre,
        email: email ?? existente.email,
        telefono: telefono ?? existente.telefono,
      });
    }

    return turnoRepository.insertarCliente(db, {
      tenant_id: tenantId,
      nombre: datos.nombre,
      email,
      telefono,
      consentimiento: true,
    });
  },
};