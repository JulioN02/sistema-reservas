import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Database } from "../db";
import { tenants } from "../db/schema";
import { assertTenantId } from "../infra/tenant";

/**
 * Helpers de repositorio que exigen `tenant_id` en TODA query (RB-INT-01,
 * INT-S1). Ningún query del sistema puede construirse sin pasar por acá.
 */

/**
 * Construye la condición base scoped: `tenant_id = $1 AND <condiciones>`.
 * Fail-fast si falta el tenant_id (INT-S3).
 */
export function filtroTenant(
  tenantId: string | undefined,
  columnaTenantId: PgColumn,
  ...condiciones: SQL[]
): SQL | undefined {
  assertTenantId(tenantId);
  return and(eq(columnaTenantId, tenantId), ...condiciones);
}

/** Repositorio mínimo de tenants (resolución pública + tests de aislamiento). */
export const tenantRepository = {
  /** Busca un tenant por slug; `undefined` si no existe. */
  porSlug(db: Database, slug: string) {
    return db.query.tenants.findFirst({
      where: eq(tenants.slug, slug),
      columns: { id: true, slug: true, timezone: true },
    });
  },

  /** Verifica que el tenant exista (scoped por definición: el propio tenant). */
  async existe(db: Database, tenantId: string): Promise<boolean> {
    const encontrado = await db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: { id: true },
    });
    return encontrado !== undefined;
  },
};