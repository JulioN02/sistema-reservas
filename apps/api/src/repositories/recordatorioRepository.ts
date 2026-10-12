import { and, eq, lte } from "drizzle-orm";
import { RecordatorioEstado } from "@sistema-reservas/contracts";
import type {
  RecordatorioCanal,
  TurnoEstado,
} from "@sistema-reservas/contracts";
import type { Database } from "../db";
import {
  clientes,
  recordatorios,
  servicios,
  tenants,
  turnos,
} from "../db/schema";

/**
 * Repositorio de recordatorios (T-12): la propia tabla es la cola del
 * scheduler (diseño §6.2). Queries Drizzle parametrizadas (nunca
 * interpolación, OWASP) y acotadas por `tenant_id` donde corresponde.
 *
 * `tomarPendientes` ejecuta el reclamo con `FOR UPDATE OF recordatorios SKIP
 * LOCKED` (evita doble procesamiento entre instancias y NO bloquea la fila del
 * tenant — no interfiere con el mutex del claim atómico de turnos, diseño §5).
 */

export interface RecordatorioPendiente {
  id: string;
  tenant_id: string;
  turno_id: string;
  canal: RecordatorioCanal;
  programado_para: Date;
  intentos: number;
  turno_estado: TurnoEstado;
  turno_inicio: Date;
  /** sha256 del token de gestión; el raw token no se persiste (RB-CMR-01). */
  turno_token_hash: string;
  cliente_id: string;
  cliente_nombre: string;
  cliente_email: string | null;
  servicio_id: string;
  servicio_nombre: string;
  tenant_timezone: string;
}

export const recordatorioRepository = {
  /**
   * Recordatorios vencidos (`estado='programado' AND programado_para<=ahora`),
   * ordenados por vencimiento y limitados (default 50). El lock de fila con
   * SKIP LOCKED garantiza exactamente-un procesamiento.
   */
  async tomarPendientes(
    db: Database,
    ahora: Date,
    limite = 50,
  ): Promise<RecordatorioPendiente[]> {
    return db
      .select({
        id: recordatorios.id,
        tenant_id: recordatorios.tenant_id,
        turno_id: recordatorios.turno_id,
        canal: recordatorios.canal,
        programado_para: recordatorios.programado_para,
        intentos: recordatorios.intentos,
        turno_estado: turnos.estado,
        turno_inicio: turnos.fecha_hora_inicio,
        turno_token_hash: turnos.token_hash,
        cliente_id: turnos.cliente_id,
        cliente_nombre: clientes.nombre,
        cliente_email: clientes.email,
        servicio_id: turnos.servicio_id,
        servicio_nombre: servicios.nombre,
        tenant_timezone: tenants.timezone,
      })
      .from(recordatorios)
      .innerJoin(turnos, eq(turnos.id, recordatorios.turno_id))
      .innerJoin(clientes, eq(clientes.id, turnos.cliente_id))
      .innerJoin(servicios, eq(servicios.id, turnos.servicio_id))
      .innerJoin(tenants, eq(tenants.id, recordatorios.tenant_id))
      .where(
        and(
          eq(recordatorios.estado, RecordatorioEstado.Programado),
          lte(recordatorios.programado_para, ahora),
        ),
      )
      .orderBy(recordatorios.programado_para)
      .limit(limite)
      .for("update", { of: recordatorios, skipLocked: true });
  },

  /** Marca el recordatorio como enviado con su timestamp (CMR-S5). */
  async marcarEnviado(db: Database, id: string, enviadoEn: Date): Promise<void> {
    await db
      .update(recordatorios)
      .set({ estado: RecordatorioEstado.Enviado, enviado_en: enviadoEn })
      .where(eq(recordatorios.id, id));
  },

  /** Cancela el recordatorio sin emitir evento (RB-CMR-04/07, CMR-S6/S7). */
  async marcarCancelado(db: Database, id: string): Promise<void> {
    await db
      .update(recordatorios)
      .set({ estado: RecordatorioEstado.Cancelado })
      .where(eq(recordatorios.id, id));
  },

  /** Reprograma un reintento: incrementa intentos y fija el próximo instante. */
  async reprogramar(
    db: Database,
    id: string,
    intentos: number,
    programadoPara: Date,
    ultimoError: string,
  ): Promise<void> {
    await db
      .update(recordatorios)
      .set({ intentos, programado_para: programadoPara, ultimo_error: ultimoError })
      .where(eq(recordatorios.id, id));
  },

  /** Marca fallido tras agotar los reintentos (RB-CMR-05, CMR-S4). */
  async marcarFallido(
    db: Database,
    id: string,
    intentos: number,
    ultimoError: string,
  ): Promise<void> {
    await db
      .update(recordatorios)
      .set({ estado: RecordatorioEstado.Fallido, intentos, ultimo_error: ultimoError })
      .where(eq(recordatorios.id, id));
  },
};
