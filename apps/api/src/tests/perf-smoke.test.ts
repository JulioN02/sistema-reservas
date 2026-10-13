import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, format, parseISO, startOfISOWeek } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";
import { createDb, type Database } from "../db";
import { seedDatabase } from "../db/seed";
import { seedSintetico } from "../db/seed-sintetico";

/**
 * Smoke de performance (T-22) — umbrales RNF-01 medidos con el seed sintético
 * cargado (A7), sobre `app.inject` (HTTP en proceso, sin red):
 *
 * - CA-AGD-03: consulta de agenda p95 < 300 ms.
 * - CA-RST-02: creación de reserva p95 < 500 ms.
 * - CA-MTE-04: GET /api/v1/metricas/resumen p95 < 300 ms.
 * - CA-VNG-01: carga de la vista del día (GET /api/v1/agenda/dia) p95 < 1 s.
 *
 * Metodología: se descartan `CALENTAMIENTO` corridas previas (JIT + pool de
 * conexiones caliente, nunca cold start) y se mide el p95 de `CORRIDAS`
 * corridas. Los umbrales son los del contrato (firmes, no se relajan): si el
 * p95 los supera, el test FALLA — no hay reintentos que oculten una regresión.
 *
 * Requiere PostgreSQL de test (TEST_DATABASE_URL; override local 5437) con el
 * seed base + el seed sintético cargados.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5437/sistema_reservas_test";

/** Zona del negocio del seed demo (RB-VNG-01). */
const TZ = "America/Argentina/Buenos_Aires";
const OPERADOR_EMAIL = "operador@demo.local";
const OPERADOR_PASSWORD = "demo-password-123";

/** Ruta absoluta a apps/api/drizzle, independiente del cwd (F-02). */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Corridas descartadas antes de medir (evita el cold start). */
const CALENTAMIENTO = 5;
/** Corridas medidas para el cálculo del p95. */
const CORRIDAS = 20;
/** Umbrales del contrato RNF-01 (ms). */
const UMBRAL_AGENDA_MS = 300;
const UMBRAL_RESERVA_MS = 500;
const UMBRAL_METRICAS_MS = 300;
const UMBRAL_VISTA_DIA_MS = 1000;
/**
 * Ventana de la consulta de agenda, en días desde hoy. Es la MISMA que usa el
 * frontend (`DIAS_VENTANA = 7` en Reservar.tsx/Gestion.tsx): el smoke mide el
 * patrón de consulta real, no una ventana artificial más cara.
 */
const VENTANA_DIAS = 7;

let app: FastifyInstance;
let db: Database;
let cookie: string;
let servicioId: string;
/** Slots libres reservables, uno por corrida (calentamiento + medición). */
let slotsReserva: string[];

/** Limpia la BD de test para que la corrida sea determinista. */
async function limpiarBd(base: Database): Promise<void> {
  await base.execute(
    `TRUNCATE TABLE
      eventos_metricas, recordatorios, turnos, bloques_indisponibilidad,
      horarios_recurrentes, servicios, clientes, sesiones, operadores, tenants
      RESTART IDENTITY CASCADE`,
  );
}

function crearApp(base: Database): Promise<FastifyInstance> {
  return buildApp({
    env: parseEnv({ DATABASE_URL: TEST_DATABASE_URL, REMINDER_LEAD_MIN: "1440" }),
    db: base,
    loggerOptions: { level: "silent" },
  });
}

function sidToken(setCookie: string[] | string | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = /(?:^|;\s*)sid=([^;]+)/.exec(raw ?? "");
  return match?.[1] ?? "";
}

async function login(instancia: FastifyInstance): Promise<string> {
  const res = await instancia.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: OPERADOR_EMAIL, password: OPERADOR_PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return sidToken(res.headers["set-cookie"]);
}

/** Fecha local `yyyy-MM-dd` (zona del negocio) desplazada `dias` desde hoy. */
function fechaLocal(dias: number): string {
  const hoy = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");
  return format(addDays(parseISO(hoy), dias), "yyyy-MM-dd");
}

/** Lunes (zona del negocio) de la semana ISO actual — día con turnos del seed. */
function lunesSemanaLocal(): string {
  const hoy = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");
  return format(startOfISOWeek(parseISO(hoy)), "yyyy-MM-dd");
}

/** Servicio de 30 min del seed (id + duración). */
async function servicio30(instancia: FastifyInstance): Promise<string> {
  const res = await instancia.inject({ method: "GET", url: "/api/v1/servicios" });
  expect(res.statusCode).toBe(200);
  const servicios = res.json() as Array<{ id: string; duracion_min: number }>;
  const servicio = servicios.find((s) => s.duracion_min === 30);
  if (servicio === undefined) {
    throw new Error("sin servicio de 30 min en el seed demo");
  }
  return servicio.id;
}

/** Slots libres del servicio en la ventana [hoy, hoy + `dias`) (slot_keys). */
async function slotsLibres(
  instancia: FastifyInstance,
  idServicio: string,
  dias: number,
): Promise<string[]> {
  const res = await instancia.inject({
    method: "GET",
    url: `/api/v1/agenda?servicio_id=${idServicio}&desde=${fechaLocal(0)}&hasta=${fechaLocal(dias)}`,
  });
  expect(res.statusCode).toBe(200);
  const cuerpo = res.json() as {
    dias: Array<{ slots: Array<{ slot_key: string }> }>;
  };
  const slots: string[] = [];
  for (const dia of cuerpo.dias) {
    for (const slot of dia.slots) slots.push(slot.slot_key);
  }
  return slots;
}

/** p95 (nearest-rank) de las muestras en ms. */
function percentil95(muestras: number[]): number {
  const orden = [...muestras].sort((a, b) => a - b);
  const indice = Math.max(0, Math.ceil(0.95 * orden.length) - 1);
  return orden[indice] ?? 0;
}

/**
 * Ejecuta `ejecutar` `CALENTAMIENTO` veces (descartadas) y luego `CORRIDAS`
 * veces midiendo cada llamada. Devuelve el p95 y los códigos HTTP observados.
 *
 * Con `PERF_LOG=1` deja evidencia de la distribución (min/p50/p95/max) en la
 * salida; silencioso por defecto para no ensuciar la salida de CI.
 */
async function medir(
  etiqueta: string,
  ejecutar: (indice: number) => Promise<number>,
): Promise<{ p95: number; codigos: number[] }> {
  for (let i = 0; i < CALENTAMIENTO; i += 1) {
    await ejecutar(i);
  }
  const muestras: number[] = [];
  const codigos: number[] = [];
  for (let i = 0; i < CORRIDAS; i += 1) {
    const inicio = performance.now();
    const codigo = await ejecutar(CALENTAMIENTO + i);
    muestras.push(performance.now() - inicio);
    codigos.push(codigo);
  }
  const p95 = percentil95(muestras);
  if (process.env.PERF_LOG === "1") {
    const orden = [...muestras].sort((a, b) => a - b);
    console.log(
      `[perf-smoke] ${etiqueta}: min=${orden[0]!.toFixed(1)} p50=${orden[Math.floor(orden.length / 2)]!.toFixed(1)} p95=${p95.toFixed(1)} max=${orden[orden.length - 1]!.toFixed(1)} ms`,
    );
  }
  return { p95, codigos };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "Smoke de performance con seed sintético (T-22, RNF-01)",
  () => {
    beforeAll(async () => {
      db = createDb(TEST_DATABASE_URL);
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
      await limpiarBd(db);
      await seedDatabase(TEST_DATABASE_URL);
      await seedSintetico(TEST_DATABASE_URL, { ahora: new Date() });
      app = await crearApp(db);
      cookie = await login(app);
      servicioId = await servicio30(app);
      const slots = await slotsLibres(app, servicioId, VENTANA_DIAS);
      const necesarios = CALENTAMIENTO + CORRIDAS;
      if (slots.length < necesarios) {
        throw new Error(
          `slots libres insuficientes para el smoke (${slots.length} < ${necesarios})`,
        );
      }
      slotsReserva = slots.slice(0, necesarios);
    }, 120_000);

    afterAll(async () => {
      await app?.close();
    });

    it("CA-AGD-03: GET /agenda p95 < 300 ms con el seed sintético", async () => {
      const url = `/api/v1/agenda?servicio_id=${servicioId}&desde=${fechaLocal(0)}&hasta=${fechaLocal(VENTANA_DIAS)}`;
      const { p95, codigos } = await medir("CA-AGD-03 agenda", async () => {
        const res = await app.inject({ method: "GET", url });
        return res.statusCode;
      });
      // El endpoint realmente corrió y devolvió 200 en TODAS las corridas.
      expect(new Set(codigos)).toEqual(new Set([200]));
      expect(p95).toBeLessThan(UMBRAL_AGENDA_MS);
    });

    it("CA-RST-02: POST /turnos (reserva) p95 < 500 ms con el seed sintético", async () => {
      const { p95, codigos } = await medir("CA-RST-02 reserva", async (i) => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/turnos",
          payload: {
            servicio_id: servicioId,
            slot_key: slotsReserva[i]!,
            cliente: { nombre: "Perf Smoke", email: "perf.smoke@example.com" },
            consentimiento: true,
          },
        });
        return res.statusCode;
      });
      // Cada corrida reservó un slot DISTINTO → 201 (0 colisiones, 0 rechazos).
      expect(new Set(codigos)).toEqual(new Set([201]));
      expect(p95).toBeLessThan(UMBRAL_RESERVA_MS);
    });

    it("CA-MTE-04: GET /metricas/resumen p95 < 300 ms con el seed sintético", async () => {
      const { p95, codigos } = await medir("CA-MTE-04 métricas", async () => {
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/metricas/resumen",
          headers: { cookie: `sid=${cookie}` },
        });
        return res.statusCode;
      });
      expect(new Set(codigos)).toEqual(new Set([200]));
      expect(p95).toBeLessThan(UMBRAL_METRICAS_MS);
    });

    it("CA-VNG-01: GET /agenda/dia (vista del día) p95 < 1000 ms con el seed sintético", async () => {
      const url = `/api/v1/agenda/dia?fecha=${lunesSemanaLocal()}`;
      const { p95, codigos } = await medir("CA-VNG-01 vista del día", async () => {
        const res = await app.inject({
          method: "GET",
          url,
          headers: { cookie: `sid=${cookie}` },
        });
        return res.statusCode;
      });
      expect(new Set(codigos)).toEqual(new Set([200]));
      expect(p95).toBeLessThan(UMBRAL_VISTA_DIA_MS);
    });
  },
);
