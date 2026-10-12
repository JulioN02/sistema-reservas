import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { TurnoEstado } from "@sistema-reservas/contracts";
import type { RecordatorioCanal } from "@sistema-reservas/contracts";
import type { Database } from "../db";
import {
  clientes,
  recordatorios,
  servicios,
  tenants,
  turnos,
} from "../db/schema";
import type { Cliente } from "../db/schema";
import { filtroTenant } from "./tenantScoped";

/**
 * Repositorio de turnos (T-10): queries Drizzle parametrizadas (nunca
 * interpolación, OWASP) con `tenant_id` obligatorio vía filtroTenant
 * (RB-INT-01, INT-S1). El chequeo de solapamiento usa `tstzrange &&`
 * (diseño §5); los insert de turno/evento/recordatorio se ejecutan SIEMPRE
 * dentro de la misma transacción (`conLockDeTenant`) — CA-MTE-01.
 */

/** Marcador de PII eliminada en la anonimización (PRV-02). No es PII. */
export const MARCA_ELIMINADO = "[eliminado]";

/**
 * Turno con todo el contexto necesario para gestión/cancelación/reagenda
 * (T-11/T-14): estado, horario, cliente, servicio (duración, ventana, gracia)
 * y datos de contacto del negocio (RB-CRG-02). Se resuelve tanto por token
 * (enlace público, derivación implícita turno → tenant) como por id scoped.
 */
export interface TurnoConContexto {
  id: string;
  tenant_id: string;
  estado: TurnoEstado;
  fecha_hora_inicio: Date;
  fecha_hora_fin: Date;
  motivo: string | null;
  token_hash: string;
  cliente_id: string;
  cliente_nombre: string;
  cliente_email: string | null;
  servicio_id: string;
  servicio_nombre: string;
  servicio_duracion_min: number;
  servicio_booking_window_days: number;
  servicio_grace_min: number;
  tenant_timezone: string;
  tenant_email_contacto: string | null;
  tenant_telefono_contacto: string | null;
}

/** Columnas del contexto de gestión (mismo shape para token e id). */
const COLUMNAS_CONTEXTO = {
  id: turnos.id,
  tenant_id: turnos.tenant_id,
  estado: turnos.estado,
  fecha_hora_inicio: turnos.fecha_hora_inicio,
  fecha_hora_fin: turnos.fecha_hora_fin,
  motivo: turnos.motivo,
  token_hash: turnos.token_hash,
  cliente_id: turnos.cliente_id,
  cliente_nombre: clientes.nombre,
  cliente_email: clientes.email,
  servicio_id: turnos.servicio_id,
  servicio_nombre: servicios.nombre,
  servicio_duracion_min: servicios.duracion_min,
  servicio_booking_window_days: servicios.booking_window_days,
  servicio_grace_min: servicios.cancellation_grace_minutes,
  tenant_timezone: tenants.timezone,
  tenant_email_contacto: tenants.email_contacto,
  tenant_telefono_contacto: tenants.telefono_contacto,
} as const;

/** Estados activos (ocupan slot): pendiente/confirmado. */
const ESTADOS_ACTIVOS: TurnoEstado[] = [
  TurnoEstado.Pendiente,
  TurnoEstado.Confirmado,
];

/**
 * Fila de lista del negocio (T-15): columnas de TurnoResumen del contrato.
 * Las fechas llegan como Date (UTC); el servicio las serializa a ISO.
 */
export interface TurnoResumenFila {
  id: string;
  estado: TurnoEstado;
  cliente_nombre: string;
  servicio_nombre: string;
  fecha_hora_inicio: Date;
  fecha_hora_fin: Date;
}

/** Fila de detalle (T-15): columnas de TurnoDetalle del contrato. */
export interface TurnoDetalleFila {
  id: string;
  estado: TurnoEstado;
  motivo: string | null;
  fecha_hora_inicio: Date;
  fecha_hora_fin: Date;
  cliente_nombre: string;
  cliente_email: string | null;
  cliente_telefono: string | null;
  servicio_id: string;
  servicio_nombre: string;
  servicio_duracion_min: number;
  servicio_precio: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Columnas de TurnoResumen (join cliente + servicio). */
const COLUMNAS_RESUMEN = {
  id: turnos.id,
  estado: turnos.estado,
  cliente_nombre: clientes.nombre,
  servicio_nombre: servicios.nombre,
  fecha_hora_inicio: turnos.fecha_hora_inicio,
  fecha_hora_fin: turnos.fecha_hora_fin,
} as const;

/** Columnas de TurnoDetalle (join cliente + servicio). */
const COLUMNAS_DETALLE = {
  id: turnos.id,
  estado: turnos.estado,
  motivo: turnos.motivo,
  fecha_hora_inicio: turnos.fecha_hora_inicio,
  fecha_hora_fin: turnos.fecha_hora_fin,
  cliente_nombre: clientes.nombre,
  cliente_email: clientes.email,
  cliente_telefono: clientes.telefono,
  servicio_id: turnos.servicio_id,
  servicio_nombre: servicios.nombre,
  servicio_duracion_min: servicios.duracion_min,
  servicio_precio: servicios.precio,
  created_at: turnos.created_at,
  updated_at: turnos.updated_at,
} as const;

/**
 * Tope defensivo del historial (T-15): el contrato NO declara paginación
 * (limit/offset), así que se limita el resultado a un máximo sensato para
 * evitar respuestas sin cota. Con los filtros del panel el subconjunto
 * esperado (CA-VNG-04) queda holgadamente por debajo de este tope.
 */
export const LIMITE_HISTORIAL = 200;

/** Filtros opcionales del historial (estado + rango [desde, hasta]). */
export interface HistorialFiltros {
  estado?: TurnoEstado;
  desde?: Date;
  hasta?: Date;
}

export const turnoRepository = {
  /**
   * ¿Existe un turno ACTIVO (pendiente/confirmado) que solapa [inicio, fin)?
   * Chequeo rápido del claim (diseño §5 paso 2), bajo el mutex del tenant.
   * `excluirTurnoId` (T-14) permite reagendar el MISMO turno sin que su propio
   * horario anterior cuente como solapamiento.
   */
  async hayTurnoActivoQueSolapa(
    db: Database,
    tenantId: string,
    inicio: Date,
    fin: Date,
    excluirTurnoId?: string,
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
          ...(excluirTurnoId === undefined
            ? []
            : [sql`${turnos.id} <> ${excluirTurnoId}`]),
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
   * Anonimiza la PII de un cliente (PRV-02, R-D7). Conserva `id`, `tenant_id`
   * y la relación con turnos/eventos (retención sin PII). Scoped por tenant_id
   * (RB-INT-01): `undefined` si el cliente no existe en ese tenant.
   *
   * Estrategia (ver Reporte de desviaciones de T-18): el CHECK
   * `clientes_canal_check` exige al menos un canal de contacto, así que email y
   * teléfono NO pueden quedar ambos en NULL. El email SÍ se vacía a NULL —de
   * otro modo el índice único parcial `(tenant_id, lower(email))` colisionaría
   * al anonimizar dos clientes del mismo tenant con el mismo marcador—; el
   * teléfono conserva el marcador no-PII "[eliminado]" para satisfacer el CHECK.
   */
  async anonimizarCliente(
    db: Database,
    tenantId: string,
    id: string,
  ): Promise<Cliente | undefined> {
    const filas = await db
      .update(clientes)
      .set({
        nombre: MARCA_ELIMINADO,
        email: null,
        telefono: MARCA_ELIMINADO,
        updated_at: new Date(),
      })
      .where(filtroTenant(tenantId, clientes.tenant_id, eq(clientes.id, id)))
      .returning();
    return filas[0];
  },

  /**
   * Turno + servicio + cliente + negocio por `token_hash` (T-11/T-14). El
   * token es la derivación implícita turno → tenant (RB-INT-02): `token_hash`
   * es único global, así que esta lectura NO necesita tenant_id; toda mutación
   * posterior sí lo exige (RB-INT-01). Devuelve `undefined` si el token no
   * corresponde a ningún turno (CMR-S3: respuesta genérica, sin revelar).
   */
  async turnoGestionPorTokenHash(
    db: Database,
    tokenHash: string,
  ): Promise<TurnoConContexto | undefined> {
    const filas = await db
      .select(COLUMNAS_CONTEXTO)
      .from(turnos)
      .innerJoin(clientes, eq(clientes.id, turnos.cliente_id))
      .innerJoin(servicios, eq(servicios.id, turnos.servicio_id))
      .innerJoin(tenants, eq(tenants.id, turnos.tenant_id))
      .where(eq(turnos.token_hash, tokenHash))
      .limit(1);
    return filas[0];
  },

  /**
   * Turno + contexto por id DENTRO del tenant (T-14, acciones de negocio).
   * `undefined` si no existe o es de otro tenant (404 — INT-S1).
   */
  async turnoConContextoPorId(
    db: Database,
    tenantId: string,
    turnoId: string,
  ): Promise<TurnoConContexto | undefined> {
    const filas = await db
      .select(COLUMNAS_CONTEXTO)
      .from(turnos)
      .innerJoin(clientes, eq(clientes.id, turnos.cliente_id))
      .innerJoin(servicios, eq(servicios.id, turnos.servicio_id))
      .innerJoin(tenants, eq(tenants.id, turnos.tenant_id))
      .where(
        and(eq(turnos.id, turnoId), eq(turnos.tenant_id, tenantId)),
      )
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

  /**
   * Transición condicional idempotente `activo → nuevoEstado` (T-14): solo
   * actualiza si el turno sigue en pendiente/confirmado (RB-CRG-06/EC-12).
   * `undefined` si ya estaba en un estado terminal (nada que escribir → sin
   * evento). Scoped por tenant_id (RB-INT-01). `motivo` opcional: se escribe
   * solo cuando se pasa explícitamente (cancelación de negocio, RB-CRG-03).
   */
  async transicionarSiActivo(
    db: Database,
    tenantId: string,
    turnoId: string,
    nuevoEstado: TurnoEstado,
    motivo?: string | null,
  ): Promise<{ id: string; estado: TurnoEstado } | undefined> {
    const cambios: {
      estado: TurnoEstado;
      updated_at: Date;
      motivo?: string | null;
    } = { estado: nuevoEstado, updated_at: new Date() };
    if (motivo !== undefined) cambios.motivo = motivo;
    const filas = await db
      .update(turnos)
      .set(cambios)
      .where(
        and(
          eq(turnos.id, turnoId),
          eq(turnos.tenant_id, tenantId),
          inArray(turnos.estado, ESTADOS_ACTIVOS),
        ),
      )
      .returning({ id: turnos.id, estado: turnos.estado });
    return filas[0];
  },

  /**
   * Reagenda el MISMO turno (RB-CRG-04): nueva fecha/hora conservando id,
   * cliente, servicio y estado. Solo desde un estado activo (terminal → sin
   * fila). Scoped por tenant_id. La atomicidad la garantiza la transacción
   * del llamador (libera el slot anterior + reclama el nuevo, CA-CRG-03).
   */
  async reagendarTurno(
    db: Database,
    tenantId: string,
    turnoId: string,
    fechaHoraInicio: Date,
    fechaHoraFin: Date,
    motivo?: string | null,
  ): Promise<{ id: string; estado: TurnoEstado } | undefined> {
    const cambios: {
      fecha_hora_inicio: Date;
      fecha_hora_fin: Date;
      updated_at: Date;
      motivo?: string | null;
    } = {
      fecha_hora_inicio: fechaHoraInicio,
      fecha_hora_fin: fechaHoraFin,
      updated_at: new Date(),
    };
    if (motivo !== undefined) cambios.motivo = motivo;
    const filas = await db
      .update(turnos)
      .set(cambios)
      .where(
        and(
          eq(turnos.id, turnoId),
          eq(turnos.tenant_id, tenantId),
          inArray(turnos.estado, ESTADOS_ACTIVOS),
        ),
      )
      .returning({ id: turnos.id, estado: turnos.estado });
    return filas[0];
  },

  /**
   * Turnos cuyo inicio cae en `[inicio, fin)` — vista del día (T-15,
   * VNG-S3/RB-VNG-01). El rango lo calcula el servicio en la zona del
   * negocio; orden cronológico ascendente. Scoped por tenant_id (INT-S1).
   */
  async turnosDelDia(
    db: Database,
    tenantId: string,
    inicio: Date,
    fin: Date,
  ): Promise<TurnoResumenFila[]> {
    return db
      .select(COLUMNAS_RESUMEN)
      .from(turnos)
      .innerJoin(clientes, eq(clientes.id, turnos.cliente_id))
      .innerJoin(servicios, eq(servicios.id, turnos.servicio_id))
      .where(
        filtroTenant(
          tenantId,
          turnos.tenant_id,
          sql`${turnos.fecha_hora_inicio} >= ${inicio}`,
          sql`${turnos.fecha_hora_inicio} < ${fin}`,
        ),
      )
      .orderBy(asc(turnos.fecha_hora_inicio));
  },

  /**
   * Historial filtrable (T-15, VNG-02/VNG-S6): por estado y/o rango
   * `[desde, hasta]` inclusive, orden descendente por inicio, tope defensivo
   * (LIMITE_HISTORIAL). Scoped por tenant_id (INT-S1).
   */
  async historialTurnos(
    db: Database,
    tenantId: string,
    filtros: HistorialFiltros,
  ): Promise<TurnoResumenFila[]> {
    const condiciones: SQL[] = [];
    if (filtros.estado !== undefined) {
      condiciones.push(eq(turnos.estado, filtros.estado));
    }
    if (filtros.desde !== undefined) {
      condiciones.push(sql`${turnos.fecha_hora_inicio} >= ${filtros.desde}`);
    }
    if (filtros.hasta !== undefined) {
      condiciones.push(sql`${turnos.fecha_hora_inicio} <= ${filtros.hasta}`);
    }
    return db
      .select(COLUMNAS_RESUMEN)
      .from(turnos)
      .innerJoin(clientes, eq(clientes.id, turnos.cliente_id))
      .innerJoin(servicios, eq(servicios.id, turnos.servicio_id))
      .where(filtroTenant(tenantId, turnos.tenant_id, ...condiciones))
      .orderBy(desc(turnos.fecha_hora_inicio))
      .limit(LIMITE_HISTORIAL);
  },

  /**
   * Detalle por id DENTRO del tenant (T-15, INT-S1): `undefined` si no existe
   * o si el turno es de otro tenant (404 sin filtrar datos — mismo camino que
   * inexistente).
   */
  async turnoDetallePorId(
    db: Database,
    tenantId: string,
    turnoId: string,
  ): Promise<TurnoDetalleFila | undefined> {
    const filas = await db
      .select(COLUMNAS_DETALLE)
      .from(turnos)
      .innerJoin(clientes, eq(clientes.id, turnos.cliente_id))
      .innerJoin(servicios, eq(servicios.id, turnos.servicio_id))
      .where(and(eq(turnos.id, turnoId), eq(turnos.tenant_id, tenantId)))
      .limit(1);
    return filas[0];
  },
};