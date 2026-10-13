import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";
import { createDb, type Database } from "../db";
import { seedDatabase } from "../db/seed";
import { seedSintetico, type KpisEsperados } from "../db/seed-sintetico";

/**
 * MTE-S5 (A7) — seed sintético vs fixture de KPIs (T-22).
 *
 * Escenario: GIVEN el seed de datos sintéticos; WHEN se abre la vista de
 * métricas (GET /api/v1/metricas/resumen, sesión demo); THEN los 4 KPIs
 * coinciden con el cálculo manual del seed (± 0.1 pp) — CA-MTE-02.
 *
 * El fixture `apps/api/fixtures/kpis-expected.json` lo produce el generador
 * (`seed-sintetico.ts`) de forma determinista; este test NO lo reescribe, lo
 * LEE y compara los CONTADOS (las etiquetas de semana ISO dependen del ancla,
 * pero los contados/tasas son invariantes de fecha por diseño del generador).
 *
 * Requiere PostgreSQL de test (TEST_DATABASE_URL; override local 5437).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5437/sistema_reservas_test";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));
const FIXTURE_PATH = fileURLToPath(
  new URL("../../fixtures/kpis-expected.json", import.meta.url),
);

const OPERADOR_EMAIL = "operador@demo.local";
const OPERADOR_PASSWORD = "demo-password-123";

/** Tolerancia de tasas: ± 0.1 pp (CA-MTE-02). */
const TOLERANCIA = 0.001;

interface Fixture {
  kpis: KpisEsperados;
}

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

async function crearApp(db: Database): Promise<FastifyInstance> {
  return buildApp({
    env: parseEnv({ DATABASE_URL: TEST_DATABASE_URL, REMINDER_LEAD_MIN: "1440" }),
    db,
    loggerOptions: { level: "silent" },
  });
}

function sidToken(setCookie: string[] | string | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = /(?:^|;\s*)sid=([^;]+)/.exec(raw ?? "");
  return match?.[1] ?? "";
}

async function login(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: OPERADOR_EMAIL, password: OPERADOR_PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return sidToken(res.headers["set-cookie"]);
}

async function resumen(
  app: FastifyInstance,
  cookie: string,
): Promise<{
  reservas_por_semana: Array<{ semana: string; cantidad: number }>;
  tasa_no_show: number | null;
  ocupacion_semana: number | null;
  cancelaciones: { cantidad: number; tasa: number };
}> {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/metricas/resumen",
    headers: { cookie: `sid=${cookie}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "MTE-S5 — seed sintético vs fixture de KPIs (T-22)",
  () => {
    it("CA-MTE-02: los 4 KPIs de GET /metricas/resumen coinciden con el fixture (±0.1pp)", async () => {
      const db = await prepararBd();
      const ahora = new Date();
      await seedSintetico(TEST_DATABASE_URL, { ahora });

      const app = await crearApp(db);
      const cookie = await login(app);
      const cuerpo = await resumen(app, cookie);

      const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
      const esperado = fixture.kpis;

      // KPI 1 — reservas por semana ISO (8 semanas): contados exactos.
      expect(esperado.reservas_por_semana.length).toBe(8);
      expect(cuerpo.reservas_por_semana.map((r) => r.cantidad)).toEqual(
        esperado.reservas_por_semana.map((r) => r.cantidad),
      );

      // KPI 2 — tasa de no-show (± 0.1 pp; no nula: hay terminales post-fecha).
      expect(cuerpo.tasa_no_show).not.toBeNull();
      expect(esperado.tasa_no_show).not.toBeNull();
      expect(
        Math.abs((cuerpo.tasa_no_show ?? 0) - (esperado.tasa_no_show ?? 0)),
      ).toBeLessThanOrEqual(TOLERANCIA);

      // KPI 3 — ocupación de la semana actual (± 0.1 pp; no nula: hay horarios).
      expect(cuerpo.ocupacion_semana).not.toBeNull();
      expect(esperado.ocupacion_semana).not.toBeNull();
      expect(
        Math.abs(
          (cuerpo.ocupacion_semana ?? 0) - (esperado.ocupacion_semana ?? 0),
        ),
      ).toBeLessThanOrEqual(TOLERANCIA);

      // KPI 4 — cancelaciones (cantidad exacta + tasa ± 0.1 pp).
      expect(cuerpo.cancelaciones.cantidad).toBe(
        esperado.cancelaciones.cantidad,
      );
      expect(
        Math.abs(cuerpo.cancelaciones.tasa - esperado.cancelaciones.tasa),
      ).toBeLessThanOrEqual(TOLERANCIA);

      await app.close();
    });

    it("triangulación: el generador es determinista (misma semilla → mismos KPIs)", async () => {
      const db = await prepararBd();
      const ahora = new Date();
      const a = await seedSintetico(TEST_DATABASE_URL, { ahora });
      const b = await seedSintetico(TEST_DATABASE_URL, { ahora });
      expect(a.kpis).toEqual(b.kpis);
      expect(a.turnos).toBeGreaterThan(100);
      expect(a.eventos).toBeGreaterThan(a.turnos);
      await db.execute("SELECT 1");
    });
  },
);
