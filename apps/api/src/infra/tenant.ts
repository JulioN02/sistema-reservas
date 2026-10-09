import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { tenants } from "../db/schema";
import { NotFoundError } from "./errors";

/**
 * Aislamiento multi-tenant (diseño §4.1, spec INT-02).
 *
 * - Endpoints públicos (sin sesión): tenant = DEFAULT_TENANT_SLUG (env);
 *   nunca se expone `tenant_id` en respuestas públicas (CA-INT-04). El enlace
 *   público deriva turno → tenant implícito vía token (RB-INT-02).
 * - Endpoints negocio (sesión): tenant desde la sesión (T-07 inyecta el
 *   `tenant_id` vía `contextoNegocio`).
 * - Guard fail-fast en desarrollo si falta tenant_id (RB-INT-01, INT-S3).
 */

export type TipoContextoTenant = "publico" | "negocio";

export interface TenantContext {
  tenant_id: string;
  tipo: TipoContextoTenant;
}

/** Resuelve el tenant público desde DEFAULT_TENANT_SLUG (RB-INT-03). */
export async function resolverTenantPublico(
  db: Database,
  slug: string,
): Promise<TenantContext> {
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.slug, slug),
    columns: { id: true },
  });
  if (tenant === undefined) {
    throw new NotFoundError(
      `El tenant público '${slug}' no está configurado.`,
    );
  }
  return { tenant_id: tenant.id, tipo: "publico" };
}

/** Contexto de negocio desde la sesión del operador (usado por T-07). */
export function contextoNegocio(tenantId: string): TenantContext {
  return { tenant_id: tenantId, tipo: "negocio" };
}

/**
 * Guard fail-fast (INT-S3, RB-INT-01): ninguna query puede ejecutarse sin
 * `tenant_id`. Lanza siempre (no solo en desarrollo) — el mensaje distingue
 * el modo para facilitar el diagnóstico.
 */
export function assertTenantId(
  tenantId: string | undefined,
): asserts tenantId is string {
  if (tenantId === undefined || tenantId === "") {
    const modo = process.env.NODE_ENV === "development" ? "development" : "producción";
    throw new Error(
      `Guard de aislamiento: falta tenant_id en el contexto (RB-INT-01, INT-S3) — modo ${modo}.`,
    );
  }
}