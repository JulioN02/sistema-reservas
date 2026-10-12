import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";
import { createDb, type Database } from "../db";
import { seedDatabase } from "../db/seed";
import { clientes, eventosMetricas, recordatorios, servicios, turnos } from "../db/schema";
import { descomponerSlotKey } from "../dto/turnos";
import { hashToken } from "../services/authService";
import {
  calcularProgramadoPara,
  elegirAlternativas,
  type SlotOferta,
} from "../services/turnoService";

/**
 * Reserva de turnos (T-10) — POST /api/v1/turnos con claim atómico
 * (diseño §5): mutex por tenant + solapamiento tstzrange + índice único
 * parcial como red final (RB-RST-01, CA-RST-01).
 *
 * Escenarios GWT de la spec:
 * - RST-S1: 201 + turno pendiente + evento reserva_creada + enlace de gestión.
 * - RST-S2: dos claims al mismo slot → 1×201 / 1×409 con alternativas.
 * - RST-S3: solapamiento parcial de intervalos → 409.
 * - RST-S4/CA-RST-03: sin canal de contacto → 422.
 * - RST-S5: solo teléfono → 201 y recordatorio sin canal email.
 * - RST-S6/CA-RST-04: slot en el pasado → 422.
 * - RST-S7/CA-RST-05: mismo email → 1 solo registro tras 10 reservas.
 * - RST-S8: negocio autenticado → 201 idéntico (origen business).
 * - CA-MTE-01: exactamente 1 evento reserva_creada por reserva.
 *
 * Requiere PostgreSQL de test (TEST_DATABASE_URL; default db-test:5433).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/sistema_reservas_test";

const OPERADOR_EMAIL = "operador@demo.local";
const OPERADOR_PASSWORD = "demo-password-123";

/** Ruta absoluta a apps/api/drizzle, independiente del cwd (F-02). */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Limpia la BD de test para que cada corrida sea determinista. */
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

/** Fecha YYYY-MM-DD (UTC) desplazada `dias` desde hoy. */
function fechaISO(dias: number): string {
  return new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);
}

/** Todos los slots libres del servicio en [hoy, hoy + dias), ordenados. */
async function slotsLibres(
  app: FastifyInstance,
  servicioId: string,
  dias: number,
): Promise<Array<{ slot_key: string; fecha_hora_inicio: string }>> {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/agenda?servicio_id=${servicioId}&desde=${fechaISO(0)}&hasta=${fechaISO(dias)}`,
  });
  expect(res.statusCode).toBe(200);
  const cuerpo = res.json() as {
    dias: Array<{
      fecha: string;
      slots: Array<{ slot_key: string; fecha_hora_inicio: string }>;
    }>;
  };
  const slots: Array<{ slot_key: string; fecha_hora_inicio: string }> = [];
  for (const dia of cuerpo.dias) {
    slots.push(...dia.slots);
  }
  return slots.sort((a, b) =>
    a.fecha_hora_inicio.localeCompare(b.fecha_hora_inicio),
  );
}

/**
 * Primer slot libre con inicio ≥ ahora + `minAheadMs` (para escenarios que
 * exigen `inicio − lead` en el futuro — RB-CMR-03).
 */
async function primerSlotLibre(
  app: FastifyInstance,
  servicioId: string,
  dias = 7,
  minAheadMs = 0,
): Promise<{ slot_key: string; inicio: string }> {
  const slots = await slotsLibres(app, servicioId, dias);
  const slot = slots.find(
    (s) =>
      new Date(s.fecha_hora_inicio).getTime() >= Date.now() + minAheadMs,
  );
  if (slot === undefined) {
    throw new Error("sin slots libres en el rango consultado");
  }
  return { slot_key: slot.slot_key, inicio: slot.fecha_hora_inicio };
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

/** Servicio del seed por duración (30/45/60 min). */
async function servicioPorDuracion(
  app: FastifyInstance,
  duracion: number,
): Promise<{ id: string; duracion_min: number }> {
  const res = await app.inject({ method: "GET", url: "/api/v1/servicios" });
  expect(res.statusCode).toBe(200);
  const servicios = res.json() as Array<{ id: string; duracion_min: number }>;
  const servicio = servicios.find((s) => s.duracion_min === duracion);
  if (servicio === undefined) {
    throw new Error(`sin servicio de ${duracion} min en seed`);
  }
  return servicio;
}

function hacerReserva(
  app: FastifyInstance,
  cuerpo: Record<string, unknown>,
  cookie?: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/turnos",
    payload: cuerpo,
    ...(cookie === undefined ? {} : { headers: { cookie: `sid=${cookie}` } }),
  });
}

/** Extrae el token `sid` de la cookie seteada por el servidor. */
function sidToken(setCookie: string[] | string | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(raw, "debe existir Set-Cookie con la sesión").toBeDefined();
  const match = /(?:^|;\s*)sid=([^;]+)/.exec(raw ?? "");
  expect(match, "Set-Cookie debe contener la cookie sid").not.toBeNull();
  return match?.[1] ?? "";
}

// --- Helpers puros (unidad) ---

describe("descomponerSlotKey — parsing del slot_key (RB-AGD-07)", () => {
  const SERVICIO = "16f9d3d2-3a4b-4c5d-8e6f-1a2b3c4d5e6f";

  it("descompone `<inicio_utc ISO8601>|<servicio_id>` válido", () => {
    expect(
      descomponerSlotKey(`2026-10-12T12:00:00.000Z|${SERVICIO}`),
    ).toEqual({
      inicio_utc: new Date("2026-10-12T12:00:00.000Z"),
      servicio_id: SERVICIO,
    });
  });

  it("null si falta el separador o la fecha no es ISO 8601", () => {
    expect(descomponerSlotKey("sin-separador")).toBeNull();
    expect(descomponerSlotKey(`no-es-fecha|${SERVICIO}`)).toBeNull();
  });
});

describe("calcularProgramadoPara — lead del recordatorio (RB-CMR-03)", () => {
  const inicio = new Date("2026-10-12T12:00:00.000Z");

  it("con tiempo de sobra → inicio − lead", () => {
    expect(
      calcularProgramadoPara(inicio, 1440, new Date("2026-10-10T12:00:00.000Z"))
        .toISOString(),
    ).toBe("2026-10-11T12:00:00.000Z");
  });

  it("resto ≤ lead → inmediato (ahora)", () => {
    const ahora = new Date("2026-10-12T06:00:00.000Z");
    expect(calcularProgramadoPara(inicio, 1440, ahora)).toBe(ahora);
  });
});

describe("elegirAlternativas — 3 primeros slots posteriores (RB-RST-02)", () => {
  const slots: SlotOferta[] = [
    {
      slot_key: "2026-10-12T12:00:00.000Z|svc",
      fecha_hora_inicio: new Date("2026-10-12T12:00:00.000Z"),
      fecha_hora_fin: new Date("2026-10-12T12:30:00.000Z"),
    },
    {
      slot_key: "2026-10-12T12:30:00.000Z|svc",
      fecha_hora_inicio: new Date("2026-10-12T12:30:00.000Z"),
      fecha_hora_fin: new Date("2026-10-12T13:00:00.000Z"),
    },
    {
      slot_key: "2026-10-12T13:00:00.000Z|svc",
      fecha_hora_inicio: new Date("2026-10-12T13:00:00.000Z"),
      fecha_hora_fin: new Date("2026-10-12T13:30:00.000Z"),
    },
    {
      slot_key: "2026-10-12T13:30:00.000Z|svc",
      fecha_hora_inicio: new Date("2026-10-12T13:30:00.000Z"),
      fecha_hora_fin: new Date("2026-10-12T14:00:00.000Z"),
    },
  ];

  it("solo slots estrictamente posteriores al solicitado, máx. 3, en orden", () => {
    const pedido = new Date("2026-10-12T12:00:00.000Z");
    expect(elegirAlternativas(slots, pedido)).toEqual([
      "2026-10-12T12:30:00.000Z|svc",
      "2026-10-12T13:00:00.000Z|svc",
      "2026-10-12T13:30:00.000Z|svc",
    ]);
  });

  it("si hay menos de 3 posteriores → devuelve los que haya", () => {
    const pedido = new Date("2026-10-12T13:00:00.000Z");
    expect(elegirAlternativas(slots, pedido)).toEqual([
      "2026-10-12T13:30:00.000Z|svc",
    ]);
  });
});

// --- Integración (BD de test + HTTP) ---

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "reserva de turnos — endpoints (T-10)",
  () => {
    it("RST-S1: slot libre → 201 {turno_id, estado:pendiente, enlace_gestion, cliente_id} + cliente + 1 evento reserva_creada + recordatorio programado", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);

      const servicio = await primerServicio(app);
      // Slot ≥ 25 h en el futuro: garantiza que `inicio − lead (24 h)` sea
      // posterior a `ahora` y el programado_para sea determinista (RB-CMR-03).
      const slot = await primerSlotLibre(app, servicio.id, 7, 25 * 3_600_000);

      const res = await hacerReserva(app, {
        servicio_id: servicio.id,
        slot_key: slot.slot_key,
        cliente: { nombre: "Ana García", email: "ana@example.com" },
        consentimiento: true,
      });
      expect(res.statusCode).toBe(201);

      // TurnoCreado: {turno_id, estado, enlace_gestion, cliente_id} (contrato).
      const cuerpo = res.json() as {
        turno_id: string;
        estado: string;
        enlace_gestion: string;
        cliente_id: string;
      };
      expect(cuerpo.turno_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(cuerpo.estado).toBe("pendiente");
      expect(cuerpo.cliente_id).toMatch(/^[0-9a-f-]{36}$/);
      // Enlace de gestión /g/{token}: token opaco 32 B base64url (RB-CMR-01).
      const token = cuerpo.enlace_gestion.replace(/^\/g\//, "");
      expect(cuerpo.enlace_gestion).toMatch(/^\/g\/[A-Za-z0-9_-]{43}$/);

      // La BD guarda sha256(token), NUNCA el token en claro.
      const turno = await db.query.turnos.findFirst({
        where: eq(turnos.id, cuerpo.turno_id),
      });
      expect(turno).toBeDefined();
      expect(turno?.token_hash).toBe(hashToken(token));
      expect(turno?.token_hash).not.toBe(token);
      expect(turno?.estado).toBe("pendiente");
      expect(turno?.fecha_hora_inicio.toISOString()).toBe(
        new Date(slot.inicio).toISOString(),
      );
      expect(turno?.fecha_hora_fin.getTime()).toBe(
        new Date(slot.inicio).getTime() + servicio.duracion_min * 60_000,
      );

      // Cliente con consentimiento registrado (PRV-01).
      const cliente = await db.query.clientes.findFirst({
        where: eq(clientes.id, cuerpo.cliente_id),
      });
      expect(cliente).toBeDefined();
      expect(cliente?.email).toBe("ana@example.com");
      expect(cliente?.consentimiento).toBe(true);

      // CA-MTE-01: exactamente 1 evento reserva_creada, payload sin PII (§13).
      const eventos = await db
        .select()
        .from(eventosMetricas)
        .where(
          and(
            eq(eventosMetricas.turno_id, cuerpo.turno_id),
            eq(eventosMetricas.tipo, "reserva_creada"),
          ),
        );
      expect(eventos).toHaveLength(1);
      expect(eventos[0]?.cliente_id).toBe(cuerpo.cliente_id);
      expect(eventos[0]?.origen).toBe("public");
      const payload = eventos[0]?.payload as Record<string, unknown>;
      expect(payload.slot_inicio_utc).toBe(slot.inicio);
      expect(payload.slot_fin_utc).toBe(
        new Date(
          new Date(slot.inicio).getTime() + servicio.duracion_min * 60_000,
        ).toISOString(),
      );
      expect(payload.canal_contacto).toBe("email");
      expect(payload.creado_por).toBe("cliente");
      // Sin PII en el payload (RB-MTE-04): nada del cliente más que el canal.
      expect(JSON.stringify(payload)).not.toContain("ana@example.com");

      // Recordatorio programado: inicio − lead (1440 min); canal email.
      const recordatorio = await db.query.recordatorios.findFirst({
        where: eq(recordatorios.turno_id, cuerpo.turno_id),
      });
      expect(recordatorio).toBeDefined();
      expect(recordatorio?.estado).toBe("programado");
      expect(recordatorio?.canal).toBe("email");
      expect(recordatorio?.programado_para.toISOString()).toBe(
        new Date(
          new Date(slot.inicio).getTime() - 1440 * 60_000,
        ).toISOString(),
      );

      await app.close();
    });

    it("RST-S2/RB-RST-01: dos claims al mismo slot → 1×201 y 1×409 con ≤3 alternativas posteriores; 1 solo turno y 1 solo evento (CA-MTE-01)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const slot = await primerSlotLibre(app, servicio.id);
      const cuerpo = {
        servicio_id: servicio.id,
        slot_key: slot.slot_key,
        cliente: { nombre: "Bruno", email: "bruno@example.com" },
        consentimiento: true,
      };

      const primero = await hacerReserva(app, cuerpo);
      expect(primero.statusCode).toBe(201);

      const segundo = await hacerReserva(app, cuerpo);
      expect(segundo.statusCode).toBe(409);
      expect(segundo.headers["content-type"]).toContain(
        "application/problem+json",
      );
      expect(segundo.json().type).toContain("/conflicto");

      // Alternativas (RB-RST-02): ≤3 slot_keys estrictamente posteriores.
      const alternativas = (segundo.json().alternativas ?? []) as string[];
      expect(alternativas.length).toBeGreaterThan(0);
      expect(alternativas.length).toBeLessThanOrEqual(3);
      const solicitado = new Date(slot.inicio).getTime();
      for (const alt of alternativas) {
        expect(alt).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[0-9a-f-]{36}$/,
        );
        const inicioAlt = new Date(alt.split("|")[0]!).getTime();
        expect(inicioAlt).toBeGreaterThan(solicitado);
      }

      // CA-RST-01 (sin estrés — la prueba de concurrencia es de T-19):
      // exactamente 1 turno y exactamente 1 evento reserva_creada.
      const turnosEnBd = await db.select().from(turnos);
      expect(turnosEnBd).toHaveLength(1);
      const eventos = await db.select().from(eventosMetricas);
      expect(eventos).toHaveLength(1);
      expect(eventos[0]?.tipo).toBe("reserva_creada");

      await app.close();
    });

    it("RST-S3 (EC-01): solapamiento parcial → 409 con tstzrange &&; inicio adyacente exacto → 201", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio30 = await primerServicio(app);
      const servicio45 = await servicioPorDuracion(app, 45);

      // El primer slot libre del día (09:00 local = 12:00Z): margen holgado
      // para los rangos +15/+30 min del escenario sin tocar el cierre.
      const base = await primerSlotLibre(app, servicio30.id);
      const inicioBase = new Date(base.inicio).getTime();

      // Turno A 30 min en `base` (ej.: 12:00–12:30Z).
      const a = await hacerReserva(app, {
        servicio_id: servicio30.id,
        slot_key: base.slot_key,
        cliente: { nombre: "Clara", email: "clara@example.com" },
        consentimiento: true,
      });
      expect(a.statusCode).toBe(201);

      // B 45 min comenzando 15 min después → solapa parcialmente → 409.
      const parcial = await hacerReserva(app, {
        servicio_id: servicio45.id,
        slot_key: `${new Date(inicioBase + 15 * 60_000).toISOString()}|${servicio45.id}`,
        cliente: { nombre: "Diego", email: "diego@example.com" },
        consentimiento: true,
      });
      expect(parcial.statusCode).toBe(409);

      // C 45 min comenzando exactamente en el fin de A → adyacente (sin
      // solape, intervalos medio-abiertos) → 201.
      const adyacente = await hacerReserva(app, {
        servicio_id: servicio45.id,
        slot_key: `${new Date(inicioBase + 30 * 60_000).toISOString()}|${servicio45.id}`,
        cliente: { nombre: "Diego", email: "diego@example.com" },
        consentimiento: true,
      });
      expect(adyacente.statusCode).toBe(201);

      await app.close();
    });

    it("RST-S4/CA-RST-03: reserva sin canal de contacto → 422 problem+json con errores[]", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const slot = await primerSlotLibre(app, servicio.id);

      const res = await hacerReserva(app, {
        servicio_id: servicio.id,
        slot_key: slot.slot_key,
        cliente: { nombre: "Sin Canal" },
        consentimiento: true,
      });
      expect(res.statusCode).toBe(422);
      expect(res.headers["content-type"]).toContain(
        "application/problem+json",
      );
      const cuerpo = res.json() as {
        type: string;
        errores: Array<{ campo: string; mensaje: string }>;
      };
      expect(cuerpo.type).toContain("/validacion");
      expect(cuerpo.errores.length).toBeGreaterThan(0);
      expect(cuerpo.errores.map((e) => e.campo)).toContain("cliente");

      // 0 % de reservas sin canal: nada persistido.
      expect(await db.select().from(clientes)).toHaveLength(0);
      expect(await db.select().from(turnos)).toHaveLength(0);

      await app.close();
    });

    it("RST-S5 (EC-13): solo teléfono → 201; recordatorio SIN canal email (canal log)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const slot = await primerSlotLibre(app, servicio.id);

      const res = await hacerReserva(app, {
        servicio_id: servicio.id,
        slot_key: slot.slot_key,
        cliente: { nombre: "Elena", telefono: "+54 11 5555-0199" },
        consentimiento: true,
      });
      expect(res.statusCode).toBe(201);

      const cuerpo = res.json() as { turno_id: string };
      const recordatorio = await db.query.recordatorios.findFirst({
        where: eq(recordatorios.turno_id, cuerpo.turno_id),
      });
      expect(recordatorio).toBeDefined();
      expect(recordatorio?.canal).toBe("log");

      // Payload del evento (spec §13): canal_contacto = telefono.
      const evento = await db.query.eventosMetricas.findFirst({
        where: eq(eventosMetricas.turno_id, cuerpo.turno_id),
      });
      expect((evento?.payload as Record<string, unknown>).canal_contacto).toBe(
        "telefono",
      );

      await app.close();
    });

    it("RST-S6/CA-RST-04: slot en el pasado → 422 siempre, nada persistido", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);

      const ayer = new Date(Date.now() - 24 * 3_600_000);
      const res = await hacerReserva(app, {
        servicio_id: servicio.id,
        slot_key: `${ayer.toISOString()}|${servicio.id}`,
        cliente: { nombre: "Fabián", email: "fabian@example.com" },
        consentimiento: true,
      });
      expect(res.statusCode).toBe(422);
      const cuerpo = res.json() as {
        type: string;
        errores: Array<{ campo: string; mensaje: string }>;
      };
      expect(cuerpo.type).toContain("/validacion");
      expect(cuerpo.errores.map((e) => e.campo)).toContain("slot_key");
      expect(await db.select().from(turnos)).toHaveLength(0);

      await app.close();
    });

    it("RST-S7/CA-RST-05 (EC-16): 10 reservas con el mismo email → 10×201 y 1 solo registro de cliente", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const slots = await slotsLibres(app, servicio.id, 7);

      // 10 slots consecutivos libres (seed: 18 slots/día laboral).
      const diez = slots.slice(0, 10);
      expect(diez).toHaveLength(10);

      for (const slot of diez) {
        const res = await hacerReserva(app, {
          servicio_id: servicio.id,
          slot_key: slot.slot_key,
          // Mayúsculas: la normalización (lower) debe deduplicar igual.
          cliente: { nombre: "Gustavo", email: "Gustavo@Example.COM" },
          consentimiento: true,
        });
        expect(res.statusCode).toBe(201);
      }

      // Dedup por email normalizado: 1 solo registro (CA-RST-05).
      const registros = await db
        .select()
        .from(clientes)
        .where(eq(clientes.email, "gustavo@example.com"));
      expect(registros).toHaveLength(1);

      // CA-MTE-01: exactamente 1 evento reserva_creada por reserva (10).
      const eventos = await db.select().from(eventosMetricas);
      expect(eventos).toHaveLength(10);

      await app.close();
    });

    it("RST-S8 (RF-08): negocio autenticado → 201 idéntico al público; evento origen business / creado_por negocio", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const slot = await primerSlotLibre(app, servicio.id);

      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: OPERADOR_EMAIL, password: OPERADOR_PASSWORD },
      });
      expect(login.statusCode).toBe(200);
      const cookie = sidToken(login.headers["set-cookie"]);

      const res = await hacerReserva(
        app,
        {
          servicio_id: servicio.id,
          slot_key: slot.slot_key,
          cliente: { nombre: "Hugo", telefono: "+54 11 5555-0200" },
          consentimiento: true,
        },
        cookie,
      );
      expect(res.statusCode).toBe(201);

      // Mismo shape TurnoCreado que el flujo público (sin tenant_id, CA-INT-04).
      const cuerpo = res.json() as Record<string, unknown>;
      expect(Object.keys(cuerpo).sort()).toEqual([
        "cliente_id",
        "enlace_gestion",
        "estado",
        "turno_id",
      ]);
      expect(cuerpo.estado).toBe("pendiente");

      // Origen business + creado_por negocio en el evento (spec §13).
      const turno = await db.query.turnos.findFirst({
        where: eq(turnos.id, cuerpo.turno_id as string),
      });
      expect(turno).toBeDefined();
      const evento = await db.query.eventosMetricas.findFirst({
        where: eq(eventosMetricas.turno_id, turno!.id),
      });
      expect(evento?.origen).toBe("business");
      expect((evento?.payload as Record<string, unknown>).creado_por).toBe(
        "negocio",
      );

      await app.close();
    });

    it("PRV-01/CA-RST-03: consentimiento false → 422 con errores[] (campo consentimiento)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const slot = await primerSlotLibre(app, servicio.id);

      const res = await hacerReserva(app, {
        servicio_id: servicio.id,
        slot_key: slot.slot_key,
        cliente: { nombre: "Irene", email: "irene@example.com" },
        consentimiento: false,
      });
      expect(res.statusCode).toBe(422);
      const cuerpo = res.json() as {
        errores: Array<{ campo: string; mensaje: string }>;
      };
      expect(cuerpo.errores.map((e) => e.campo)).toContain("consentimiento");
      expect(await db.select().from(turnos)).toHaveLength(0);
      expect(await db.select().from(clientes)).toHaveLength(0);

      await app.close();
    });

    it("RB-AGD-02/RB-RST-05: slot fuera de la ventana de reserva del servicio → 422", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);

      // 40 días > booking_window_days (30) del seed.
      const lejos = new Date(Date.now() + 40 * 86_400_000);
      const res = await hacerReserva(app, {
        servicio_id: servicio.id,
        slot_key: `${lejos.toISOString()}|${servicio.id}`,
        cliente: { nombre: "Julia", email: "julia@example.com" },
        consentimiento: true,
      });
      expect(res.statusCode).toBe(422);
      const cuerpo = res.json() as {
        errores: Array<{ campo: string; mensaje: string }>;
      };
      expect(cuerpo.errores.map((e) => e.campo)).toContain("slot_key");
      expect(await db.select().from(turnos)).toHaveLength(0);

      await app.close();
    });

    it("servicio inactivo → 422 (campo servicio_id); slot_key de otro servicio → 422 (campo slot_key)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const tenant = await db.query.tenants.findFirst();
      if (tenant === undefined) throw new Error("sin tenant seed");

      const inactivo = await db
        .insert(servicios)
        .values({
          tenant_id: tenant.id,
          nombre: "Servicio inactivo",
          duracion_min: 30,
          activo: false,
        })
        .returning();
      const slot = await primerSlotLibre(app, servicio.id);

      // El slot_key debe corresponder al cuerpo: usamos el id del inactivo.
      const inicio = slot.inicio;
      const inactivoRes = await hacerReserva(app, {
        servicio_id: inactivo[0]!.id,
        slot_key: `${inicio}|${inactivo[0]!.id}`,
        cliente: { nombre: "Juan", email: "juan@example.com" },
        consentimiento: true,
      });
      expect(inactivoRes.statusCode).toBe(422);
      const erroresInactivo = (
        inactivoRes.json() as { errores: Array<{ campo: string }> }
      ).errores.map((e) => e.campo);
      expect(erroresInactivo).toContain("servicio_id");

      // slot_key cuyo servicio no coincide con servicio_id → 422 (DTO).
      const otroServicio = await servicioPorDuracion(app, 45);
      const mismatch = await hacerReserva(app, {
        servicio_id: servicio.id,
        slot_key: `${inicio}|${otroServicio.id}`,
        cliente: { nombre: "Juan", email: "juan@example.com" },
        consentimiento: true,
      });
      expect(mismatch.statusCode).toBe(422);
      const erroresMismatch = (
        mismatch.json() as { errores: Array<{ campo: string }> }
      ).errores.map((e) => e.campo);
      expect(erroresMismatch).toContain("slot_key");

      await app.close();
    });
  },
);