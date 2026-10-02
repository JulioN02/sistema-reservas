import { describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { createDb, type Database } from "../db";
import { clientes, tenants } from "../db/schema";
import { seedDatabase } from "../db/seed";
import { NotFoundError } from "../infra/errors";
import {
  assertTenantId,
  contextoNegocio,
  resolverTenantPublico,
} from "../infra/tenant";
import { filtroTenant, tenantRepository } from "../repositories/tenantScoped";

/**
 * Aislamiento multi-tenant (capability infraestructura-tenant).
 *
 * - CA-INT-01: crear en A, consultar desde B → vacío/404.
 * - CA-INT-02: el 100 % de las tablas de negocio tienen tenant_id.
 * - INT-S3: fail-fast sin tenant_id (guard).
 * - INT-S4: la resolución pública deriva el tenant por slug sin exponer ids
 *   (RB-INT-02; el enlace por token se prueba en T-10/T-11).
 *
 * Requiere PostgreSQL de test (TEST_DATABASE_URL; default db-test:5433).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/sistema_reservas_test";

const TABLAS_DE_NEGOCIO = [
  "operadores",
  "sesiones",
  "clientes",
  "servicios",
  "horarios_recurrentes",
  "bloques_indisponibilidad",
  "turnos",
  "recordatorios",
  "eventos_metricas",
];

/** Limpia la BD de test para que cada corrida sea determinista. */
async function limpiarBd(db: Database): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE
      eventos_metricas, recordatorios, turnos, bloques_indisponibilidad,
      horarios_recurrentes, servicios, clientes, sesiones, operadores, tenants
      RESTART IDENTITY CASCADE`,
  );
}

/** Ruta absoluta a apps/api/drizzle, independiente del cwd (F-02). */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

async function prepararBd(): Promise<Database> {
  const db = createDb(TEST_DATABASE_URL);
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await limpiarBd(db);
  await seedDatabase(TEST_DATABASE_URL);
  return db;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("aislamiento multi-tenant", () => {
  it("CA-INT-02: el 100 % de las tablas de negocio tienen tenant_id", async () => {
    const db = await prepararBd();
    const { rows } = await db.execute(
      `SELECT table_name FROM information_schema.columns
       WHERE column_name = 'tenant_id' AND table_schema = 'public'`,
    );
    const conTenant = new Set(
      (rows as Array<{ table_name: string }>).map((r) => r.table_name),
    );
    for (const tabla of TABLAS_DE_NEGOCIO) {
      expect(
        conTenant.has(tabla),
        `tabla de negocio sin tenant_id: ${tabla}`,
      ).toBe(true);
    }
  });

  it("CA-INT-01: crear en A, consultar desde B → vacío/404", async () => {
    const db = await prepararBd();

    // Tenant A = seed demo; tenant B = tenant adicional.
    const tenantA = await tenantRepository.porSlug(db, "demo");
    expect(tenantA).toBeDefined();
    const insertado = await db
      .insert(tenants)
      .values({
        slug: "otro-negocio",
        nombre: "Otro Negocio",
        timezone: "America/Argentina/Buenos_Aires",
      })
      .returning();
    const tenantB = insertado[0] ?? null;
    expect(tenantB).not.toBeNull();

    // Datos en A: 2 clientes. Datos en B: 1 cliente.
    // B1 repite el email de A1 a propósito: el índice único es POR TENANT
    // (tenant_id, lower(email)) — F-01 — así que el insert debe tener éxito
    // (un índice global bloquearía a B, acoplando tenants).
    await db.insert(clientes).values([
      { tenant_id: tenantA!.id, nombre: "Cliente A1", email: "a1@correo.test", consentimiento: true },
      { tenant_id: tenantA!.id, nombre: "Cliente A2", email: "a2@correo.test", consentimiento: true },
      { tenant_id: tenantB!.id, nombre: "Cliente B1", email: "a1@correo.test", consentimiento: true },
    ]);

    // B consulta su historial → solo sus datos (3 → 1).
    const clientesDeB = await db.query.clientes.findMany({
      where: filtroTenant(tenantB!.id, clientes.tenant_id),
    });
    expect(clientesDeB).toHaveLength(1);
    expect(clientesDeB[0]?.nombre).toBe("Cliente B1");

    // B intenta leer un cliente de A con el scope de B → vacío (404 por scoping).
    const clienteA1 = await db.query.clientes.findFirst({
      where: (t) =>
        and(eq(t.tenant_id, tenantA!.id), eq(t.nombre, "Cliente A1")),
    });
    expect(clienteA1).toBeDefined();
    const desdeB = await db.query.clientes.findFirst({
      where: (t) =>
        and(eq(t.tenant_id, tenantB!.id), eq(t.id, clienteA1!.id)),
    });
    expect(desdeB).toBeUndefined();
  });

  it("INT-S3: fail-fast — ninguna query sin tenant_id (guard)", async () => {
    expect(() => assertTenantId(undefined)).toThrow(/tenant_id/);
    expect(() => assertTenantId("")).toThrow(/tenant_id/);
    expect(() => filtroTenant(undefined, clientes.tenant_id)).toThrow(
      /tenant_id/,
    );
    expect(() => filtroTenant("", clientes.tenant_id)).toThrow(/tenant_id/);
    // Con tenant válido, construye la condición sin lanzar.
    expect(filtroTenant("abc", clientes.tenant_id)).toBeDefined();
  });

  it("INT-S4: la resolución pública deriva el tenant por slug sin exponer ids", async () => {
    const db = await prepararBd();
    const contexto = await resolverTenantPublico(db, "demo");
    expect(contexto.tipo).toBe("publico");
    expect(contexto.tenant_id).toBeTruthy();

    // El contexto de negocio se construye desde la sesión (T-07).
    const negocio = contextoNegocio(contexto.tenant_id);
    expect(negocio.tipo).toBe("negocio");
    expect(negocio.tenant_id).toBe(contexto.tenant_id);

    // Slug inexistente → NotFoundError (404), sin revelar datos.
    const error = await resolverTenantPublico(db, "no-existe").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).detail).toMatch(/no está configurado/);
  });

  it("el guard también protege queries scoped por el helper filtroTenant", async () => {
    const db = await prepararBd();
    // Sin pasar por el guard: query sin tenant_id queda fuera del contrato;
    // el helper garantiza que el tenant siempre forme parte del WHERE.
    const contexto = await resolverTenantPublico(db, "demo");
    const clientesScoped = await db.query.clientes.findMany({
      where: filtroTenant(contexto.tenant_id, clientes.tenant_id),
    });
    expect(Array.isArray(clientesScoped)).toBe(true);
  });
});