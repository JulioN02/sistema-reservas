import { describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { count, eq } from "drizzle-orm";
import { createDb } from "../db";
import {
  horariosRecurrentes,
  operadores,
  servicios,
  tenants,
} from "../db/schema";
import { seedDatabase } from "../db/seed";

/**
 * INT-S2: en un entorno limpio, migraciones + seed crean 1 tenant con
 * operador y servicios; el seed es idempotente (RB-INT-04).
 *
 * Requiere PostgreSQL de test: TEST_DATABASE_URL (por defecto el servicio
 * `db-test` de docker-compose, puerto 5433). Se omite si no hay BD.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/sistema_reservas_test";

/** Ruta absoluta a apps/api/drizzle, independiente del cwd (F-02). */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

async function aplicarMigraciones(): Promise<void> {
  const db = createDb(TEST_DATABASE_URL);
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("seed (INT-S2)", () => {
  it("crea 1 tenant + operador + servicios y es idempotente", async () => {
    await aplicarMigraciones();
    const db = createDb(TEST_DATABASE_URL);

    const primera = await seedDatabase(TEST_DATABASE_URL);
    const segunda = await seedDatabase(TEST_DATABASE_URL);

    // Segunda ejecución: no crea nada nuevo (idempotente).
    expect(segunda.servicios).toBe(0);
    expect(segunda.horarios).toBe(0);

    // Exactamente 1 tenant con operador y servicios.
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.slug, primera.tenant_slug),
    });
    expect(tenant).toBeDefined();
    expect(tenant?.nombre).toBe("Negocio Demo");

    const [operadoresCount] = await db
      .select({ total: count() })
      .from(operadores)
      .where(eq(operadores.tenant_id, tenant!.id));
    expect(operadoresCount?.total).toBe(1);

    const [serviciosCount] = await db
      .select({ total: count() })
      .from(servicios)
      .where(eq(servicios.tenant_id, tenant!.id));
    expect(serviciosCount?.total).toBe(3);

    const [horariosCount] = await db
      .select({ total: count() })
      .from(horariosRecurrentes)
      .where(eq(horariosRecurrentes.tenant_id, tenant!.id));
    expect(horariosCount?.total).toBe(6);

    // El operador guarda un hash argon2id (no el password en claro).
    const operador = await db.query.operadores.findFirst({
      where: (t) => eq(t.email, primera.operador_email),
    });
    expect(operador?.password_hash).toMatch(/^\$argon2id\$/);
  });
});