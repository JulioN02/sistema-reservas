import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { TurnoEstado } from "@sistema-reservas/contracts";
import type { EventoOrigen, EventoTipo, RecordatorioCanal } from "@sistema-reservas/contracts";
import type { Database } from "../db";
import {
  clientes,
  eventosMetricas,
  recordatorios,
  servicios,
  turnos,
} from "../db/schema";
import { filtroTenant } from "./tenantScoped";

/**
 * Repositorio de turnos (T-10): queries Drizzle parametrizadas (nunca
 * interpolación, OWASP) con `tenant_id` obligatorio vía filtroTenant
 * (RB-INT-01, INT-S1). El chequeo de solapamiento usa `tstzrange &&`
 * (diseño §5); los insert de turno/evento/recordatorio se ejecutan SIEMPRE
 * dentro de la misma transacción (`conLockDeTenant`) — CA-MTE-01.
 */

export interface TurnoGestionFila {
  id: string;
  tenant_id: string;
  estado: TurnoEstado;
  fecha_hora_inicio: Date;
  fecha_hora_fin: Date;
  cliente_id: string;
  servicio_id: string;
  servicio: string;
  cliente_nombre: string;
}

export const turnoRepository = {
  /**
   * ¿Existe un turno ACTIVO (pendiente/confirmado) que solapa [inicio, fin)?
   * Chequeo rápido del claim (diseño §5 paso 2), bajo el mutex del tenant.
   */
  async hayTurnoActivoQueSolapa(
    db: Database,
    tenantId: string,
    inicio: Date,
    fin: Date,
  ): Promise<boolean> {
    const filas = await db
      .select({ id: turnos.id })
      .from(turnos)
      .where(
        filtroTenant(
          tenantId,
          turnos.tenant_id,
          inArray(turnos.estado, [
            TurnoEstado.Pendiente,
            TurnoEstado.Confirmado,
          ]),
          sql`tstzrange(${turnos.fecha_hora_inicio}, ${turnos.fecha_hora_fin}) && tstzrange(${inicio}, ${fin})`,
        ),
      )
      .limit(1);
    return filas.length > 0;
  },

  async insertarTurno(
    db: Database,
    datos: {
      tenant_id: string;
      cliente_id: string;
      servicio_id: string;
      token_hash: string;
      fecha_hora_inicio: Date;
      fecha_hora_fin: Date;
      estado: TurnoEstado;
    },
  ) {
    const filas = await db.insert(turnos).values(datos).returning();
    return filas[0]!;
  },

  /** Evento de métricas en la MISMA tx del cambio de estado (CA-MTE-01). */
  async insertarEvento(
    db: Database,
    datos: {
      tenant_id: string;
      turno_id: string;
      cliente_id: string;
      servicio_id: string;
      tipo: EventoTipo;
      payload: Record<string, unknown>;
      origen: EventoOrigen;
    },
  ) {
    const filas = await db
      .insert(eventosMetricas)
      .values(datos)
      .returning();
    return filas[0]!;
  },

  /** Recordatorio: la tabla es la cola del scheduler (diseño §6.2). */
  async insertarRecordatorio(
    db: Database,
    datos: {
      tenant_id: string;
      turno_id: string;
      canal: RecordatorioCanal;
      programado_para: Date;
    },
  ) {
    const filas = await db
      .insert(recordatorios)
      .values(datos)
      .returning();
    return filas[0]!;
  },

  /**
   * Cliente existente por canal (dedup soft, RB-RST-06/EC-16): email
   * normalizado (lower) o teléfono exacto, dentro del tenant.
   */
  clientePorCanal(
    db: Database,
    tenantId: string,
    email: string | null | undefined,
    telefono: string | null | undefined,
  ) {
    const condiciones: SQL[] = [];
    if (email !== null && email !== undefined) {
      condiciones.push(sql`lower(${clientes.email}) = ${email}`);
    }
    if (telefono !== null && telefono !== undefined) {
      condiciones.push(eq(clientes.telefono, telefono));
    }
    if (condiciones.length === 0) return Promise.resolve(undefined);
    // `or(...)` devuelve `SQL | undefined` solo si no hay condiciones; acá
    // siempre hay al menos una (early return arriba).
    return db.query.clientes.findFirst({
      where: (t) =>
        filtroTenant(tenantId, t.tenant_id, or(...condiciones)!),
    });
  },

  async insertarCliente(
    db: Database,
    datos: {
      tenant_id: string;
      nombre: string;
      email: string | null;
      telefono: string | null;
      consentimiento: boolean;
    },
  ) {
    const filas = await db
      .insert(clientes)
      .values({ ...datos, consentido_en: new Date() })
      .returning();
    return filas[0]!;
  },

  /**
   * Refresca los datos de contacto de un cliente existente al reutilizarlo
   * (RB-RST-06): se conservan los canales previos y se suman los nuevos;
   * el consentimiento se reafirma con su fecha (PRV-01).
   */
  async actualizarDatosCliente(
    db: Database,
    tenantId: string,
    id: string,
    datos: { nombre: string; email: string | null; telefono: string | null },
  ) {
    const filas = await db
      .update(clientes)
      .set({
        nombre: datos.nombre,
        email: datos.email,
        telefono: datos.telefono,
        consentimiento: true,
        consentido_en: new Date(),
        updated_at: new Date(),
      })
      .where(filtroTenant(tenantId, clientes.tenant_id, eq(clientes.id, id)))
      .returning();
    return filas[0]!;
  },

  /**
   * Turno + servicio + cliente por `token_hash` (T-11). El token es la
   * derivación implícita turno → tenant (RB-INT-02): `token_hash` es único
   * global, así que esta lectura NO necesita tenant_id; toda mutación
   * posterior sí lo exige (RB-INT-01). Devuelve `undefined` si el token no
   * corresponde a ningún turno (CMR-S3: respuesta genérica, sin revelar).
   */
  async turnoGestionPorTokenHash(
    db: Database,
    tokenHash: string,
  ): Promise<TurnoGestionFila | undefined> {
    const filas = await db
      .select({
        id: turnos.id,
        tenant_id: turnos.tenant_id,
        estado: turnos.estado,
        fecha_hora_inicio: turnos.fecha_hora_inicio,
        fecha_hora_fin: turnos.fecha_hora_fin,
        cliente_id: turnos.cliente_id,
        servicio_id: turnos.servicio_id,
        servicio: servicios.nombre,
        cliente_nombre: clientes.nombre,
      })
      .from(turnos)
      .innerJoin(clientes, eq(clientes.id, turnos.cliente_id))
      .innerJoin(servicios, eq(servicios.id, turnos.servicio_id))
      .where(eq(turnos.token_hash, tokenHash))
      .limit(1);
    return filas[0];
  },

  /**
   * UPDATE condicional idempotente (RB-CMR-02, T-11): `pendiente` →
   * `confirmado`. Devuelve la fila actualizada o `undefined` si el turno ya
   * no estaba pendiente (ya confirmado/terminal) — en ese caso NO se emite
   * evento (CA-CMR-01: exactamente 1 evento por transición). Scoped por
   * tenant_id (el mutex de agenda no aplica: el lock de fila del UPDATE
   * serializa confirmaciones concurrentes del mismo turno).
   */
  async confirmarSiPendiente(
    db: Database,
    tenantId: string,
    turnoId: string,
  ): Promise<{ id: string; estado: TurnoEstado } | undefined> {
    const filas = await db
      .update(turnos)
      .set({ estado: TurnoEstado.Confirmado, updated_at: new Date() })
      .where(
        and(
          eq(turnos.id, turnoId),
          eq(turnos.tenant_id, tenantId),
          eq(turnos.estado, TurnoEstado.Pendiente),
        ),
      )
      .returning({ id: turnos.id, estado: turnos.estado });
    return filas[0];
  },

  /** Estado actual del turno (re-lectura post-UPDATE para idempotencia). */
  async turnoEstadoPorId(
    db: Database,
    tenantId: string,
    turnoId: string,
  ): Promise<{ id: string; estado: TurnoEstado } | undefined> {
    const filas = await db
      .select({ id: turnos.id, estado: turnos.estado })
      .from(turnos)
      .where(
        and(eq(turnos.id, turnoId), eq(turnos.tenant_id, tenantId)),
      )
      .limit(1);
    return filas[0];
  },
};