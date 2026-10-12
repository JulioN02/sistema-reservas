import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";
import { type Database } from "../db";
import * as schema from "../db/schema";
import { seedDatabase } from "../db/seed";
import { eventosMetricas, turnos } from "../db/schema";

/**
 * Concurrencia — 100 POST simultáneos al MISMO slot (T-19, CA-RST-01).
 *
 * Ejercita el claim atómico del diseño §5 bajo contención real: mutex por
 * tenant (`SELECT … FOR UPDATE` sobre `tenants`) + re-chequeo de solapamiento
 * `tstzrange &&` + índice único parcial `(tenant_id, fecha_hora_inicio)` como
 * red final (R-D4).
 *
 * Escenario GWT (RST-S2, versión estrés):
 *   Dado un slot libre del seed (servicio activo, canal email + consentimiento),
 *   Cuando 100 clientes lo reclaman a la vez,
 *   Entonces exactamente 1 recibe 201 y los 99 restantes 409 con `alternativas[]`;
 *   la BD queda con exactamente 1 turno activo sobre ese slot y exactamente
 *   1 evento `reserva_creada` (0 dobles asignaciones, CA-MTE-01).
 *
 * Requiere PostgreSQL de test (TEST_DATABASE_URL; override local 5437).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5437/sistema_reservas_test";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Cantidad de claims simultáneos del escenario de estrés (CA-RST-01). */
const CLAIMS_SIMULTANEOS = 100;

/**
 * Pool amplio y timeout holgado: con 100 requests en vuelo, el pool por
 * defecto (max 10, timeout 2 s) puede agotarse y devolver errores de conexión
 * en CI lento, enmascarando el 409 real del claim atómico. Este es un ajuste
 * de infraestructura de test, no de la lógica bajo prueba.
 */
function createDbConcurrente(databaseUrl: string): Database {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 50,
    connectionTimeoutMillis: 10_000,
  });
  return drizzle(pool, { schema });
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
  const db = createDbConcurrente(TEST_DATABASE_URL);
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

/** Fecha YYYY-MM-DD (UTC) desplazada `dias` desde hoy. */
function fechaISO(dias: number): string {
  return new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);
}

async function primerServicio(
  app: FastifyInstance,
): Promise<{ id: string; duracion_min: number }> {
  const res = await app.inject({ method: "GET", url: "/api/v1/servicios" });
  expect(res.statusCode).toBe(200);
  const servicios = res.json() as Array<{ id: string; duracion_min: number }>;
  const servicio = servicios.find((s) => s.duracion_min === 30);
  if (servicio === undefined) throw new Error("sin servicio de 30 min en seed");
  return servicio;
}

/**
 * Primer slot libre con inicio ≥ ahora + `minAheadMs`. El margen evita que el
 * slot se vuelva "pasado" durante los pocos segundos que dura el test (la
 * reserva en el pasado responde 422 — RST-S6).
 */
async function primerSlotLibre(
  app: FastifyInstance,
  servicioId: string,
  minAheadMs: number,
): Promise<{ slot_key: string; inicio: string }> {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/agenda?servicio_id=${servicioId}&desde=${fechaISO(0)}&hasta=${fechaISO(7)}`,
  });
  expect(res.statusCode).toBe(200);
  const cuerpo = res.json() as {
    dias: Array<{
      slots: Array<{ slot_key: string; fecha_hora_inicio: string }>;
    }>;
  };
  const slots = cuerpo.dias
    .flatMap((d) => d.slots)
    .sort((a, b) => a.fecha_hora_inicio.localeCompare(b.fecha_hora_inicio));
  const slot = slots.find(
    (s) => new Date(s.fecha_hora_inicio).getTime() >= Date.now() + minAheadMs,
  );
  if (slot === undefined) throw new Error("sin slots libres en el rango");
  return { slot_key: slot.slot_key, inicio: slot.fecha_hora_inicio };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "concurrencia — claim atómico bajo estrés (T-19)",
  () => {
    it("RST-S2/CA-RST-01: 100 claims simultáneos al mismo slot → exactamente 1×201 y 99×409 con alternativas; 0 dobles asignaciones y 1 solo evento reserva_creada", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      // Margen de 1 h: el slot sigue siendo futuro durante toda la corrida.
      const slot = await primerSlotLibre(app, servicio.id, 3_600_000);
      const inicio = new Date(slot.inicio);
      const fin = new Date(inicio.getTime() + servicio.duracion_min * 60_000);

      // 100 clientes distintos (IP distinta) para aislar la concurrencia del
      // rate limit por IP (60/min): el objeto bajo prueba es el claim, no el
      // límite de tasa. Todos apuntan al MISMO slot.
      const peticiones = Array.from(
        { length: CLAIMS_SIMULTANEOS },
        (_, i) =>
          app.inject({
            method: "POST",
            url: "/api/v1/turnos",
            remoteAddress: `10.0.0.${i + 1}`,
            payload: {
              servicio_id: servicio.id,
              slot_key: slot.slot_key,
              cliente: {
                nombre: `Cliente ${i}`,
                email: `cliente${i}@example.com`,
              },
              consentimiento: true,
            },
          }),
      );
      const respuestas = await Promise.all(peticiones);

      // Exactamente 1 ganador (201) y 99 perdedores (409); ningún otro código.
      const exitos = respuestas.filter((r) => r.statusCode === 201);
      const conflictos = respuestas.filter((r) => r.statusCode === 409);
      const otros = respuestas.filter(
        (r) => r.statusCode !== 201 && r.statusCode !== 409,
      );
      expect(otros.map((r) => r.statusCode)).toEqual([]);
      expect(exitos).toHaveLength(1);
      expect(conflictos).toHaveLength(CLAIMS_SIMULTANEOS - 1);

      // El ganador devuelve el contrato TurnoCreado.
      const ganador = exitos[0]!.json() as {
        turno_id: string;
        estado: string;
        enlace_gestion: string;
        cliente_id: string;
      };
      expect(ganador.estado).toBe("pendiente");
      expect(ganador.turno_id).toMatch(/^[0-9a-f-]{36}$/);

      // Cada 409 es problem+json de conflicto con ≤3 alternativas posteriores.
      const solicitado = inicio.getTime();
      for (const conflicto of conflictos) {
        expect(conflicto.headers["content-type"]).toContain(
          "application/problem+json",
        );
        const cuerpo = conflicto.json() as {
          type: string;
          alternativas?: string[];
        };
        expect(cuerpo.type).toContain("/conflicto");
        const alternativas = cuerpo.alternativas ?? [];
        expect(alternativas.length).toBeGreaterThan(0);
        expect(alternativas.length).toBeLessThanOrEqual(3);
        for (const alt of alternativas) {
          const inicioAlt = new Date(alt.split("|")[0]!).getTime();
          expect(inicioAlt).toBeGreaterThan(solicitado);
        }
      }

      // --- Verificación por query: 0 dobles asignaciones (CA-RST-01) ---
      const tenant = await db.query.tenants.findFirst();
      if (tenant === undefined) throw new Error("sin tenant seed");

      // Exactamente 1 turno en total (nadie más pudo insertar).
      expect(await db.select().from(turnos)).toHaveLength(1);

      // Exactamente 1 turno ACTIVO solapando el slot solicitado.
      const solapados = await db.execute(sql`
        SELECT COUNT(*)::int AS n
        FROM turnos
        WHERE tenant_id = ${tenant.id}
          AND estado IN ('pendiente', 'confirmado')
          AND tstzrange(fecha_hora_inicio, fecha_hora_fin)
              && tstzrange(${inicio}::timestamptz, ${fin}::timestamptz)
      `);
      const filaSolape = solapados.rows[0] as { n: number } | undefined;
      expect(filaSolape?.n).toBe(1);

      // Exactamente 1 evento reserva_creada (CA-MTE-01), del turno ganador.
      const eventos = await db
        .select()
        .from(eventosMetricas)
        .where(eq(eventosMetricas.tipo, "reserva_creada"));
      expect(eventos).toHaveLength(1);
      expect(eventos[0]?.turno_id).toBe(ganador.turno_id);

      await app.close();
    }, 90_000);
  },
);
