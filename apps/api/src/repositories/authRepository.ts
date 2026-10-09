import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "../db";
import { operadores, sesiones } from "../db/schema";
import { filtroTenant } from "./tenantScoped";

/**
 * Repositorio de auth (T-07): queries Drizzle parametrizadas (nunca
 * interpolación, OWASP) con `tenant_id` obligatorio vía filtroTenant
 * (RB-INT-01, INT-S1). La BD solo guarda el sha256 del token opaco
 * (`sesiones.token_hash`, RB-VNG-05).
 */

export interface DatosCrearSesion {
  operador_id: string;
  tenant_id: string;
  token_hash: string;
  expires_at: Date;
}

export interface SesionConOperador {
  sesion_id: string;
  operador_id: string;
  tenant_id: string;
  email: string;
  nombre: string;
}

export const authRepository = {
  /**
   * Busca el operador por email normalizado dentro del tenant. El email se
   * compara en minúsculas (el seed no normaliza el valor de la env).
   */
  porEmail(db: Database, tenantId: string, email: string) {
    return db.query.operadores.findFirst({
      where: (t) =>
        filtroTenant(
          tenantId,
          t.tenant_id,
          sql`lower(${t.email}) = lower(${email})`,
        ),
      columns: {
        id: true,
        tenant_id: true,
        email: true,
        nombre: true,
        password_hash: true,
      },
    });
  },

  async crearSesion(db: Database, datos: DatosCrearSesion): Promise<void> {
    await db.insert(sesiones).values(datos);
  },

  /**
   * Sesión válida por token_hash: no revocada y dentro del TTL. Une con el
   * operador para alimentar /auth/me sin una segunda query.
   */
  async sesionActivaPorTokenHash(
    db: Database,
    tokenHash: string,
    ahora: Date,
  ): Promise<SesionConOperador | undefined> {
    const filas = await db
      .select({
        sesion_id: sesiones.id,
        operador_id: sesiones.operador_id,
        tenant_id: sesiones.tenant_id,
        email: operadores.email,
        nombre: operadores.nombre,
      })
      .from(sesiones)
      .innerJoin(operadores, eq(operadores.id, sesiones.operador_id))
      .where(
        and(
          eq(sesiones.token_hash, tokenHash),
          isNull(sesiones.revoked_at),
          gt(sesiones.expires_at, ahora),
        ),
      )
      .limit(1);
    return filas[0];
  },

  /** Revoca la sesión (idempotente): `revoked_at` solo si aún no lo estaba. */
  async revocarPorTokenHash(
    db: Database,
    tokenHash: string,
    ahora: Date,
  ): Promise<boolean> {
    const filas = await db
      .update(sesiones)
      .set({ revoked_at: ahora })
      .where(
        and(eq(sesiones.token_hash, tokenHash), isNull(sesiones.revoked_at)),
      )
      .returning({ id: sesiones.id });
    return filas.length > 0;
  },
};