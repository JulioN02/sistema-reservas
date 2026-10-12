import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import type { EventoTipo } from "@sistema-reservas/contracts";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";
import { createDb, type Database } from "../db";
import { seedDatabase } from "../db/seed";
import { eventosMetricas, turnos } from "../db/schema";
import type { NotificationService } from "../notificaciones/notificationService";
import { generarTokenOpaco } from "../services/authService";
import { dentroDeGracia } from "../services/turnoService";

/**
 * Cancelación, reagendulación y acciones de negocio (T-14) — capability
 * cancelacion-reagendulacion.
 *
 * Escenarios GWT de la spec:
 * - CRG-S1/CA-CRG-01: cancelación del cliente dentro de gracia → 200
 *   cancelado + evento cancelacion {por:cliente, dentro_gracia, gracia_min,
 *   motivo}; el slot vuelve a ofertarse de inmediato (≤1 s).
 * - CRG-S3/CA-CRG-02 (EC-03): cancelación fuera de gracia → 403 con el canal
 *   de contacto del negocio; el turno permanece intacto (sin evento).
 * - CRG-S8/RB-CRG-08: doble cancelación → 2×200 y EXACTAMENTE 1 evento.
 * - CRG-S4/CA-CRG-03 (EC-06): reagendar ok → mismo id/cliente/servicio/estado
 *   con nuevo horario + evento reagendulacion; slot anterior re-ofertado.
 * - CRG-S5: reagendar a slot ocupado → 409 con alternativas y el turno
 *   conserva su horario original (invariante atómica).
 * - CRG-S6/CA-CRG-04: negocio cancela sin motivo → 422 (campo motivo).
 * - VNG-S4/CA-VNG-02 (EC-04): no_show antes de inicio+30 min → rechazado.
 * - VNG-S5: no_show desde inicio+30 min → estado no_show + evento.
 * - RB-VNG-03: completado desde el inicio (no antes) → evento completado.
 * - EC-12: estados terminales rechazados (409).
 * - RB-CRG-07: reagendar/cancelar notifican por email cuando hay email.
 *
 * Requiere PostgreSQL de test (TEST_DATABASE_URL; override local 5437).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5437/sistema_reservas_test";

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

/** App con un NotificationService espía opcional (RB-CRG-07). */
async function crearApp(
  db: Database,
  notificaciones?: NotificationService,
): Promise<FastifyInstance> {
  return buildApp({
    env: parseEnv({ DATABASE_URL: TEST_DATABASE_URL, REMINDER_LEAD_MIN: "1440" }),
    db,
    loggerOptions: { level: "silent" },
    notificaciones,
  });
}

function fechaISO(dias: number): string {
  return new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);
}

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

/** Primer slot libre con inicio ≥ ahora + `minAheadMs` (default: dentro de gracia). */
async function primerSlotLibre(
  app: FastifyInstance,
  servicioId: string,
  minAheadMs = 0,
  dias = 7,
): Promise<{ slot_key: string; inicio: string }> {
  const slots = await slotsLibres(app, servicioId, dias);
  const slot = slots.find(
    (s) => new Date(s.fecha_hora_inicio).getTime() >= Date.now() + minAheadMs,
  );
  if (slot === undefined) {
    throw new Error("sin slots libres en el rango consultado");
  }
  return { slot_key: slot.slot_key, inicio: slot.fecha_hora_inicio };
}

async function primerServicio(
  app: FastifyInstance,
): Promise<{ id: string; duracion_min: number; nombre: string }> {
  const res = await app.inject({ method: "GET", url: "/api/v1/servicios" });
  expect(res.statusCode).toBe(200);
  const servicios = res.json() as Array<{
    id: string;
    duracion_min: number;
    nombre: string;
  }>;
  const servicio = servicios.find((s) => s.duracion_min === 30);
  if (servicio === undefined) throw new Error("sin servicio de 30 min en seed");
  return servicio;
}

/** Crea una reserva 201 y devuelve {turno_id, enlace_gestion, estado}. */
async function reservar(
  app: FastifyInstance,
  servicioId: string,
  cliente: Record<string, string>,
  slotKey: string,
): Promise<{ turno_id: string; enlace_gestion: string; estado: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/turnos",
    payload: {
      servicio_id: servicioId,
      slot_key: slotKey,
      cliente,
      consentimiento: true,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { turno_id: string; enlace_gestion: string; estado: string };
}

/** Token crudo extraído del enlace de gestión `/g/{token}`. */
function tokenDe(enlaceGestion: string): string {
  const token = enlaceGestion.replace(/^\/g\//, "");
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return token;
}

function cancelar(app: FastifyInstance, token: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/turnos/${token}/cancelar`,
  });
}

function reagendar(app: FastifyInstance, token: string, slotKey: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/turnos/${token}/reagendar`,
    payload: { slot_key: slotKey },
  });
}

function accion(
  app: FastifyInstance,
  turnoId: string,
  cuerpo: Record<string, unknown>,
  cookie?: string,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/turnos/${turnoId}/acciones`,
    payload: cuerpo,
    ...(cookie === undefined ? {} : { headers: { cookie: `sid=${cookie}` } }),
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

async function eventosDe(
  db: Database,
  turnoId: string,
  tipo: EventoTipo,
): Promise<Array<{ origen: string; payload: Record<string, unknown> }>> {
  const filas = await db
    .select()
    .from(eventosMetricas)
    .where(
      and(
        eq(eventosMetricas.turno_id, turnoId),
        eq(eventosMetricas.tipo, tipo),
      ),
    );
  return filas as unknown as Array<{
    origen: string;
    payload: Record<string, unknown>;
  }>;
}

/** Fija el horario de un turno (para forzar escenarios temporales). */
async function fijarHorario(
  db: Database,
  turnoId: string,
  inicio: Date,
  fin: Date,
): Promise<void> {
  await db
    .update(turnos)
    .set({ fecha_hora_inicio: inicio, fecha_hora_fin: fin, updated_at: new Date() })
    .where(eq(turnos.id, turnoId));
}

/** NotificationService espía que registra cada envío (RB-CRG-07). */
function espiaNotificaciones(): {
  servicio: NotificationService;
  enviados: Array<Record<string, unknown>>;
} {
  const enviados: Array<Record<string, unknown>> = [];
  const servicio = {
    enviar: vi.fn(async (n: Record<string, unknown>) => {
      enviados.push(n);
      return { ok: true };
    }),
  } as unknown as NotificationService;
  return { servicio, enviados };
}

// --- Helpers puros (unidad) ---

describe("dentroDeGracia — gracia de cancelación (RB-CRG-01)", () => {
  const ahora = new Date("2026-10-12T12:00:00.000Z");

  it("exactamente la gracia por delante → dentro (borde inclusivo)", () => {
    const inicio = new Date(ahora.getTime() + 180 * 60_000);
    expect(dentroDeGracia(inicio, ahora, 180)).toBe(true);
  });

  it("un minuto menos que la gracia → fuera", () => {
    const inicio = new Date(ahora.getTime() + 179 * 60_000);
    expect(dentroDeGracia(inicio, ahora, 180)).toBe(false);
  });

  it("turno ya iniciado → fuera", () => {
    const inicio = new Date(ahora.getTime() - 5 * 60_000);
    expect(dentroDeGracia(inicio, ahora, 180)).toBe(false);
  });
});

// --- Integración (BD de test + HTTP) ---

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "cancelación / reagendulación / acciones de negocio (T-14)",
  () => {
    it("CRG-S1/CA-CRG-01: cancelar dentro de gracia → 200 cancelado + 1 evento cancelacion {por:cliente, dentro_gracia:true, gracia_min, motivo:null}; slot re-ofertable de inmediato", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      // Slot ≥ 200 min: dentro de la gracia del servicio (180 min).
      const slot = await primerSlotLibre(app, servicio.id, 200 * 60_000);
      const creada = await reservar(app, servicio.id, {
        nombre: "Ana Cancel",
        email: "ana.cancel@example.com",
      }, slot.slot_key);
      const token = tokenDe(creada.enlace_gestion);

      const res = await cancelar(app, token);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        turno_id: creada.turno_id,
        estado: "cancelado",
      });

      // Estado persistido + evento en la misma tx (CA-CRG-05).
      const turno = await db.query.turnos.findFirst({
        where: eq(turnos.id, creada.turno_id),
      });
      expect(turno?.estado).toBe("cancelado");
      const eventos = await eventosDe(db, creada.turno_id, "cancelacion");
      expect(eventos).toHaveLength(1);
      expect(eventos[0]?.origen).toBe("public");
      expect(eventos[0]?.payload).toMatchObject({
        por: "cliente",
        dentro_gracia: true,
        gracia_min: 180,
        motivo: null,
      });

      // CA-CRG-01: el slot vuelve a ofertarse en la siguiente consulta.
      const libres = await slotsLibres(app, servicio.id, 7);
      expect(libres.map((s) => s.slot_key)).toContain(slot.slot_key);

      await app.close();
    });

    it("CRG-S3/CA-CRG-02 (EC-03): cancelar fuera de gracia → 403 con el canal de contacto; turno intacto y sin evento", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const slot = await primerSlotLibre(app, servicio.id, 200 * 60_000);
      const creada = await reservar(app, servicio.id, {
        nombre: "Bruno Tarde",
        email: "bruno.tarde@example.com",
      }, slot.slot_key);

      // Forzar el turno a 1 h (gracia 180 min → fuera).
      const inicio = new Date(Date.now() + 60 * 60_000);
      await fijarHorario(db, creada.turno_id, inicio, new Date(inicio.getTime() + 30 * 60_000));

      const token = tokenDe(creada.enlace_gestion);
      const res = await cancelar(app, token);
      expect(res.statusCode).toBe(403);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      const cuerpo = res.json() as { type: string; detail: string };
      expect(cuerpo.type).toContain("/prohibido");
      // RB-CRG-02: mensaje claro con canal de contacto del negocio.
      expect(cuerpo.detail).toContain("contacto@demo.local");

      // El turno permanece intacto y no se emite evento (CA-CRG-02).
      const turno = await db.query.turnos.findFirst({
        where: eq(turnos.id, creada.turno_id),
      });
      expect(turno?.estado).not.toBe("cancelado");
      expect(await eventosDe(db, creada.turno_id, "cancelacion")).toHaveLength(0);

      await app.close();
    });

    it("CRG-S8/RB-CRG-08: doble cancelación → 2×200 y EXACTAMENTE 1 evento cancelacion", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const slot = await primerSlotLibre(app, servicio.id, 200 * 60_000);
      const creada = await reservar(app, servicio.id, {
        nombre: "Carla Doble",
        email: "carla.doble@example.com",
      }, slot.slot_key);
      const token = tokenDe(creada.enlace_gestion);

      expect((await cancelar(app, token)).statusCode).toBe(200);
      const segunda = await cancelar(app, token);
      expect(segunda.statusCode).toBe(200);
      expect(segunda.json()).toEqual({
        turno_id: creada.turno_id,
        estado: "cancelado",
      });

      expect(await eventosDe(db, creada.turno_id, "cancelacion")).toHaveLength(1);

      await app.close();
    });

    it("CMR-S3/EC-12: token desconocido → 404; estado terminal (completado) → 409 sin evento", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);

      const desconocido = await cancelar(app, generarTokenOpaco());
      expect(desconocido.statusCode).toBe(404);

      const slot = await primerSlotLibre(app, servicio.id, 200 * 60_000);
      const creada = await reservar(app, servicio.id, {
        nombre: "Dora Terminal",
        email: "dora.terminal@example.com",
      }, slot.slot_key);
      await db
        .update(turnos)
        .set({ estado: "completado", updated_at: new Date() })
        .where(eq(turnos.id, creada.turno_id));

      const res = await cancelar(app, tokenDe(creada.enlace_gestion));
      expect(res.statusCode).toBe(409);
      expect(await eventosDe(db, creada.turno_id, "cancelacion")).toHaveLength(0);

      await app.close();
    });

    it("CRG-S4/CA-CRG-03 (EC-06): reagendar ok → mismo id/estado con nuevo horario + evento reagendulacion; slot anterior re-ofertado", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const slotOriginal = await primerSlotLibre(app, servicio.id, 200 * 60_000);
      const creada = await reservar(app, servicio.id, {
        nombre: "Elena Reagenda",
        email: "elena.reagenda@example.com",
      }, slotOriginal.slot_key);
      const token = tokenDe(creada.enlace_gestion);

      // Otro slot libre, distinto del original.
      const libres = await slotsLibres(app, servicio.id, 7);
      const nuevo = libres.find(
        (s) =>
          s.slot_key !== slotOriginal.slot_key &&
          new Date(s.fecha_hora_inicio).getTime() >= Date.now() + 200 * 60_000,
      );
      if (nuevo === undefined) throw new Error("sin slot alternativo libre");

      const res = await reagendar(app, token, nuevo.slot_key);
      expect(res.statusCode).toBe(200);
      const cuerpo = res.json() as {
        turno_id: string;
        estado: string;
        fecha_hora_inicio: string;
        fecha_hora_fin: string;
      };
      expect(cuerpo.turno_id).toBe(creada.turno_id);
      expect(cuerpo.estado).toBe("pendiente");
      expect(cuerpo.fecha_hora_inicio).toBe(
        new Date(nuevo.fecha_hora_inicio).toISOString(),
      );

      // Invariante RB-CRG-04: mismo id, cliente, servicio y estado; nueva fecha.
      const turno = await db.query.turnos.findFirst({
        where: eq(turnos.id, creada.turno_id),
      });
      expect(turno?.estado).toBe("pendiente");
      expect(turno?.fecha_hora_inicio.toISOString()).toBe(
        new Date(nuevo.fecha_hora_inicio).toISOString(),
      );

      // Evento reagendulacion con payload §13.
      const eventos = await eventosDe(db, creada.turno_id, "reagendulacion");
      expect(eventos).toHaveLength(1);
      expect(eventos[0]?.payload).toMatchObject({
        slot_anterior_utc: new Date(slotOriginal.inicio).toISOString(),
        slot_nuevo_utc: new Date(nuevo.fecha_hora_inicio).toISOString(),
        por: "cliente",
        dentro_gracia: true,
      });

      // El slot anterior vuelve a ofertarse; el nuevo queda ocupado.
      const despues = await slotsLibres(app, servicio.id, 7);
      const claves = despues.map((s) => s.slot_key);
      expect(claves).toContain(slotOriginal.slot_key);
      expect(claves).not.toContain(nuevo.slot_key);

      await app.close();
    });

    it("CRG-S5/CA-CRG-03: reagendar a slot ocupado → 409 con alternativas; el turno conserva su horario original", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const slots = (await slotsLibres(app, servicio.id, 7)).filter(
        (s) => new Date(s.fecha_hora_inicio).getTime() >= Date.now() + 200 * 60_000,
      );
      expect(slots.length).toBeGreaterThanOrEqual(4);

      const a = await reservar(app, servicio.id, {
        nombre: "Fabián A",
        email: "fabian.a@example.com",
      }, slots[0]!.slot_key);
      // B ocupa el slot[1] (segundo turno activo).
      await reservar(app, servicio.id, {
        nombre: "Gloria B",
        email: "gloria.b@example.com",
      }, slots[1]!.slot_key);

      // Reagendar A al slot de B (ocupado) → 409 con alternativas.
      const res = await reagendar(app, tokenDe(a.enlace_gestion), slots[1]!.slot_key);
      expect(res.statusCode).toBe(409);
      const cuerpo = res.json() as { type: string; alternativas?: string[] };
      expect(cuerpo.type).toContain("/conflicto");
      expect(Array.isArray(cuerpo.alternativas)).toBe(true);

      // A conserva su horario original; 0 dobles ocupaciones (invariante).
      const turnoA = await db.query.turnos.findFirst({
        where: eq(turnos.id, a.turno_id),
      });
      expect(turnoA?.fecha_hora_inicio.toISOString()).toBe(
        new Date(slots[0]!.fecha_hora_inicio).toISOString(),
      );
      expect(await eventosDe(db, a.turno_id, "reagendulacion")).toHaveLength(0);

      await app.close();
    });

    it("CRG-S6/CA-CRG-04: negocio cancela sin motivo → 422 (campo motivo); con motivo → 200 + evento {por:negocio, motivo}", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const cookie = await login(app);
      const slot = await primerSlotLibre(app, servicio.id, 200 * 60_000);
      const creada = await reservar(app, servicio.id, {
        nombre: "Hugo Negocio",
        email: "hugo.negocio@example.com",
      }, slot.slot_key);

      // Sin motivo → 422 (CA-CRG-04).
      const sinMotivo = await accion(app, creada.turno_id, { accion: "cancelar" }, cookie);
      expect(sinMotivo.statusCode).toBe(422);
      expect(
        (sinMotivo.json() as { errores: Array<{ campo: string }> }).errores.map(
          (e) => e.campo,
        ),
      ).toContain("motivo");

      // Con motivo → 200 + evento {por:negocio}.
      const conMotivo = await accion(
        app,
        creada.turno_id,
        { accion: "cancelar", motivo: "Cierre imprevisto" },
        cookie,
      );
      expect(conMotivo.statusCode).toBe(200);
      expect(conMotivo.json()).toEqual({
        turno_id: creada.turno_id,
        estado: "cancelado",
      });
      const eventos = await eventosDe(db, creada.turno_id, "cancelacion");
      expect(eventos).toHaveLength(1);
      expect(eventos[0]?.origen).toBe("business");
      expect(eventos[0]?.payload).toMatchObject({
        por: "negocio",
        motivo: "Cierre imprevisto",
      });

      await app.close();
    });

    it("VNG-S4/CA-VNG-02 (EC-04): no_show antes de inicio+30 min → rechazado; VNG-S5: desde inicio+30 → 200 + evento no_show", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const cookie = await login(app);
      const slot = await primerSlotLibre(app, servicio.id, 200 * 60_000);
      const creada = await reservar(app, servicio.id, {
        nombre: "Iván NoShow",
        email: "ivan.noshow@example.com",
      }, slot.slot_key);

      // Turno que empieza en 10 min → no_show no disponible.
      const en10 = new Date(Date.now() + 10 * 60_000);
      await fijarHorario(db, creada.turno_id, en10, new Date(en10.getTime() + 30 * 60_000));
      const temprano = await accion(app, creada.turno_id, { accion: "no_show" }, cookie);
      expect(temprano.statusCode).toBe(409);
      expect(await eventosDe(db, creada.turno_id, "no_show")).toHaveLength(0);

      // Turno iniciado hace 35 min → no_show disponible.
      const hace35 = new Date(Date.now() - 35 * 60_000);
      await fijarHorario(db, creada.turno_id, hace35, new Date(hace35.getTime() + 30 * 60_000));
      const ok = await accion(app, creada.turno_id, { accion: "no_show" }, cookie);
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { estado: string }).estado).toBe("no_show");
      const eventos = await eventosDe(db, creada.turno_id, "no_show");
      expect(eventos).toHaveLength(1);
      expect(eventos[0]?.payload.minutos_post_inicio).toBeGreaterThanOrEqual(30);

      await app.close();
    });

    it("RB-VNG-03: completado antes del inicio → 409; desde el inicio → 200 + evento completado", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const cookie = await login(app);
      const slot = await primerSlotLibre(app, servicio.id, 200 * 60_000);
      const creada = await reservar(app, servicio.id, {
        nombre: "Julia Completa",
        email: "julia.completa@example.com",
      }, slot.slot_key);

      const en10 = new Date(Date.now() + 10 * 60_000);
      await fijarHorario(db, creada.turno_id, en10, new Date(en10.getTime() + 30 * 60_000));
      const temprano = await accion(app, creada.turno_id, { accion: "completado" }, cookie);
      expect(temprano.statusCode).toBe(409);

      const hace5 = new Date(Date.now() - 5 * 60_000);
      await fijarHorario(db, creada.turno_id, hace5, new Date(hace5.getTime() + 30 * 60_000));
      const ok = await accion(app, creada.turno_id, { accion: "completado" }, cookie);
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { estado: string }).estado).toBe("completado");
      const eventos = await eventosDe(db, creada.turno_id, "completado");
      expect(eventos).toHaveLength(1);
      expect(eventos[0]?.payload.minutos_desde_inicio).toBeGreaterThanOrEqual(0);

      await app.close();
    });

    it("EC-12: acciones sobre un turno terminal → 409; sin sesión → 401", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const cookie = await login(app);
      const slot = await primerSlotLibre(app, servicio.id, 200 * 60_000);
      const creada = await reservar(app, servicio.id, {
        nombre: "Kevin Terminal",
        email: "kevin.terminal@example.com",
      }, slot.slot_key);

      await db
        .update(turnos)
        .set({ estado: "cancelado", updated_at: new Date() })
        .where(eq(turnos.id, creada.turno_id));

      const terminal = await accion(app, creada.turno_id, { accion: "confirmar" }, cookie);
      expect(terminal.statusCode).toBe(409);

      const sinSesion = await accion(app, creada.turno_id, { accion: "confirmar" });
      expect(sinSesion.statusCode).toBe(401);

      await app.close();
    });

    it("accion confirmar (negocio) → idempotente, medio:negocio; turno de otro tenant → 404", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const cookie = await login(app);
      const slot = await primerSlotLibre(app, servicio.id, 200 * 60_000);
      const creada = await reservar(app, servicio.id, {
        nombre: "Laura Negocio",
        email: "laura.negocio@example.com",
      }, slot.slot_key);

      const primera = await accion(app, creada.turno_id, { accion: "confirmar" }, cookie);
      expect(primera.statusCode).toBe(200);
      expect((primera.json() as { estado: string }).estado).toBe("confirmado");
      const segunda = await accion(app, creada.turno_id, { accion: "confirmar" }, cookie);
      expect(segunda.statusCode).toBe(200);

      const eventos = await eventosDe(db, creada.turno_id, "reserva_confirmada");
      expect(eventos).toHaveLength(1);
      expect(eventos[0]?.origen).toBe("business");
      expect(eventos[0]?.payload.medio).toBe("negocio");

      // Turno inexistente en el tenant → 404.
      const inexistente = await accion(
        app,
        "00000000-0000-4000-8000-000000000000",
        { accion: "confirmar" },
        cookie,
      );
      expect(inexistente.statusCode).toBe(404);

      await app.close();
    });

    it("RB-CRG-07: reagendar notifica por email cuando el cliente tiene email (reuse NotificationService)", async () => {
      const db = await prepararBd();
      const { servicio: espia, enviados } = espiaNotificaciones();
      const app = await crearApp(db, espia);
      const servicio = await primerServicio(app);
      const slotOriginal = await primerSlotLibre(app, servicio.id, 200 * 60_000);
      const creada = await reservar(app, servicio.id, {
        nombre: "Marta Aviso",
        email: "marta.aviso@example.com",
      }, slotOriginal.slot_key);
      const token = tokenDe(creada.enlace_gestion);

      const libres = await slotsLibres(app, servicio.id, 7);
      const nuevo = libres.find(
        (s) =>
          s.slot_key !== slotOriginal.slot_key &&
          new Date(s.fecha_hora_inicio).getTime() >= Date.now() + 200 * 60_000,
      );
      if (nuevo === undefined) throw new Error("sin slot alternativo libre");

      const res = await reagendar(app, token, nuevo.slot_key);
      expect(res.statusCode).toBe(200);

      expect(enviados).toHaveLength(1);
      expect(enviados[0]).toMatchObject({
        destinatario: "marta.aviso@example.com",
        cliente_nombre: "Marta Aviso",
      });

      await app.close();
    });
  },
);
