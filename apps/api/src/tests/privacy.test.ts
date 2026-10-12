import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { EventoOrigen, EventoTipo } from "@sistema-reservas/contracts";
import { createDb, type Database } from "../db";
import { clientes, eventosMetricas, servicios, tenants, turnos } from "../db/schema";
import { seedDatabase } from "../db/seed";
import { MARCA_ELIMINADO, privacyService } from "../services/privacyService";
import { hashToken } from "../services/authService";

/**
 * Privacidad (T-18, PRV-02/R-D7): anonimización de PII a pedido del negocio.
 *
 * - PRV-02: nombre → "[eliminado]"; email/teléfono se vacían en la medida que
 *   los constraints lo permiten (ver Reporte de desviaciones: el CHECK
 *   `clientes_canal_check` obliga a conservar un canal no-PII).
 * - Conserva `cliente_id`, los turnos y los eventos (retención sin PII).
 * - Scoped por tenant (RB-INT-01): no anonimiza clientes de otro tenant.
 *
 * Requiere PostgreSQL de test (TEST_DATABASE_URL; default db-test:5433).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/sistema_reservas_test";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

async function limpiarBd(db: Database): Promise<void> {
  await db.execute(
    `TRUNCATE TABLE
      eventos_metricas, recordatorios, turnos, bloques_indisponibilidad,
      horarios_recurrentes, servicios, clientes, sesiones, operadores, tenants
      RESTART IDENTITY CASCADE`,
  );
}

async function prepararBd(): Promise<Database> {
  const db = createDb(TEST_DATABASE_URL);
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await limpiarBd(db);
  await seedDatabase(TEST_DATABASE_URL);
  return db;
}

/** Crea un cliente con PII + un turno + un evento asociados. */
async function sembrarClienteConHistorial(
  db: Database,
  tenantId: string,
  datos: { nombre: string; email: string; telefono: string; slotOffsetMin?: number },
) {
  const servicio = await db.query.servicios.findFirst({
    where: eq(servicios.tenant_id, tenantId),
  });
  expect(servicio).toBeDefined();

  const cliente = (
    await db
      .insert(clientes)
      .values({
        tenant_id: tenantId,
        nombre: datos.nombre,
        email: datos.email,
        telefono: datos.telefono,
        consentimiento: true,
      })
      .returning()
  )[0]!;

  // Horario distinto por cliente: el índice único parcial de turnos activos
  // prohíbe dos turnos activos con el mismo inicio en el mismo tenant.
  const inicio = new Date(
    Date.now() + 86_400_000 + (datos.slotOffsetMin ?? 0) * 60_000,
  );
  const fin = new Date(inicio.getTime() + 30 * 60_000);
  const turno = (
    await db
      .insert(turnos)
      .values({
        tenant_id: tenantId,
        cliente_id: cliente.id,
        servicio_id: servicio!.id,
        token_hash: hashToken(randomBytes(32).toString("base64url")),
        fecha_hora_inicio: inicio,
        fecha_hora_fin: fin,
      })
      .returning()
  )[0]!;

  const evento = (
    await db
      .insert(eventosMetricas)
      .values({
        tenant_id: tenantId,
        turno_id: turno.id,
        cliente_id: cliente.id,
        servicio_id: servicio!.id,
        tipo: EventoTipo.ReservaCreada,
        payload: { medio: "enlace" },
        origen: EventoOrigen.Public,
      })
      .returning()
  )[0]!;

  return { cliente, turno, evento };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "privacidad — anonimización PRV-02 (T-18)",
  () => {
    it("PRV-02: anonimiza la PII del cliente y conserva ids, turnos y eventos", async () => {
      const db = await prepararBd();
      const tenant = await db.query.tenants.findFirst({
        where: eq(tenants.slug, "demo"),
      });
      expect(tenant).toBeDefined();

      const { cliente, turno, evento } = await sembrarClienteConHistorial(
        db,
        tenant!.id,
        { nombre: "Ana PII", email: "ana@correo.test", telefono: "555-1234" },
      );

      const anonimizado = await privacyService.anonimizarCliente(
        db,
        tenant!.id,
        cliente.id,
      );
      expect(anonimizado).toBeDefined();
      expect(anonimizado!.nombre).toBe(MARCA_ELIMINADO);
      expect(anonimizado!.email).toBeNull();
      // El CHECK clientes_canal_check exige al menos un canal: el teléfono
      // conserva el marcador no-PII (ver desviación documentada).
      expect(anonimizado!.telefono).toBe(MARCA_ELIMINADO);

      // Identidad conservada.
      expect(anonimizado!.id).toBe(cliente.id);
      expect(anonimizado!.tenant_id).toBe(tenant!.id);

      // Sin PII en la fila persistida (re-lectura, no solo el valor devuelto).
      const releido = await db.query.clientes.findFirst({
        where: eq(clientes.id, cliente.id),
      });
      const serializado = JSON.stringify(releido);
      expect(serializado).not.toContain("Ana PII");
      expect(serializado).not.toContain("ana@correo.test");
      expect(serializado).not.toContain("555-1234");

      // Turnos y eventos intactos: mismos ids y relación con el cliente.
      const turnoReleido = await db.query.turnos.findFirst({
        where: eq(turnos.id, turno.id),
      });
      expect(turnoReleido).toBeDefined();
      expect(turnoReleido!.cliente_id).toBe(cliente.id);

      const eventoReleido = await db.query.eventosMetricas.findFirst({
        where: eq(eventosMetricas.evento_id, evento.evento_id),
      });
      expect(eventoReleido).toBeDefined();
      expect(eventoReleido!.turno_id).toBe(turno.id);
      expect(eventoReleido!.cliente_id).toBe(cliente.id);
    });

    it("PRV-02 (triangulación): anonimizar dos clientes del mismo tenant no colisiona en el índice único de email", async () => {
      const db = await prepararBd();
      const tenant = await db.query.tenants.findFirst({
        where: eq(tenants.slug, "demo"),
      });
      expect(tenant).toBeDefined();

      const a = await sembrarClienteConHistorial(db, tenant!.id, {
        nombre: "Cliente A",
        email: "a@correo.test",
        telefono: "555-0001",
        slotOffsetMin: 0,
      });
      const b = await sembrarClienteConHistorial(db, tenant!.id, {
        nombre: "Cliente B",
        email: "b@correo.test",
        telefono: "555-0002",
        slotOffsetMin: 30,
      });

      // Si el email se anonimizara con un marcador no-NULL, el índice único
      // parcial `(tenant_id, lower(email))` haría fallar el segundo UPDATE.
      await expect(
        privacyService.anonimizarCliente(db, tenant!.id, a.cliente.id),
      ).resolves.toBeDefined();
      await expect(
        privacyService.anonimizarCliente(db, tenant!.id, b.cliente.id),
      ).resolves.toBeDefined();

      const restantes = await db.query.clientes.findMany({
        where: eq(clientes.tenant_id, tenant!.id),
      });
      expect(restantes).toHaveLength(2);
      expect(restantes.every((c) => c.nombre === MARCA_ELIMINADO)).toBe(true);
    });

    it("INT-S1 (scoping): un cliente de otro tenant no se anonimiza (undefined, PII intacta)", async () => {
      const db = await prepararBd();
      const tenantA = await db.query.tenants.findFirst({
        where: eq(tenants.slug, "demo"),
      });
      expect(tenantA).toBeDefined();

      const otroTenant = (
        await db
          .insert(tenants)
          .values({
            slug: "otro-negocio",
            nombre: "Otro Negocio",
            timezone: "America/Argentina/Buenos_Aires",
          })
          .returning()
      )[0]!;

      const { cliente } = await sembrarClienteConHistorial(db, tenantA!.id, {
        nombre: "Cliente de A",
        email: "a@correo.test",
        telefono: "555-9999",
      });

      // B intenta anonimizar el cliente de A → no encuentra nada (scoped).
      const resultado = await privacyService.anonimizarCliente(
        db,
        otroTenant.id,
        cliente.id,
      );
      expect(resultado).toBeUndefined();

      // La PII del cliente de A queda intacta.
      const releido = await db.query.clientes.findFirst({
        where: eq(clientes.id, cliente.id),
      });
      expect(releido!.nombre).toBe("Cliente de A");
      expect(releido!.email).toBe("a@correo.test");
    });
  },
);
