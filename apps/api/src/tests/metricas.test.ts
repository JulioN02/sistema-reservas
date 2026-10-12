import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fromZonedTime } from "date-fns-tz";
import type { FastifyInstance } from "fastify";
import {
  EventoOrigen,
  EventoTipo,
  TurnoEstado,
} from "@sistema-reservas/contracts";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";
import { createDb, type Database } from "../db";
import { seedDatabase } from "../db/seed";
import {
  clientes,
  eventosMetricas,
  horariosRecurrentes,
  servicios,
  turnos,
} from "../db/schema";
import { eventoService } from "../services/eventoService";
import {
  finSemanaISO,
  inicioSemanaISO,
  metricasService,
  ratio,
} from "../services/metricasService";
import { turnoService } from "../services/turnoService";

/**
 * Métricas y eventos (T-16) — capability metricas-eventos.
 *
 * Escenarios GWT de la spec:
 * - MTE-S1 (cadena): reserva → confirmación → no-show; el turno entra en
 *   numerador y denominador de la tasa de no-show.
 * - MTE-S2 (idempotencia, EC-17): confirmación duplicada NO duplica eventos
 *   (CA-MTE-01: exactamente 1 evento por transición).
 * - MTE-S3 (semana ISO, EC-17): eventos en semanas ISO distintas (zona del
 *   negocio) aunque cambie el mes.
 * - MTE-S4 (ocupación): horarios 9:00–13:00 (30 min → 8 slots/día × 5 días) y
 *   5 turnos confirmados el lunes → 5 ÷ 40 = 12.5 %.
 * - CA-MTE-01: cada transición de estado genera exactamente 1 evento.
 * - CA-MTE-03: auditoría — ningún evento contiene PII del cliente.
 * - VNG-S7: GET /metricas/resumen sin sesión → 401.
 *
 * CA-MTE-04 (p95 < 300 ms) es DIFERIDO a T-22 (no se construye test de perf).
 *
 * Requiere PostgreSQL de test (TEST_DATABASE_URL; override local 5437).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5437/sistema_reservas_test";

/** Zona del negocio del seed demo (RB-VNG-01/RB-MTE-03). */
const TZ = "America/Argentina/Buenos_Aires";
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

function conCookie(cookie: string): { cookie: string } {
  return { cookie: `sid=${cookie}` };
}

async function tenantDemo(db: Database) {
  const t = await db.query.tenants.findFirst({
    where: (tabla) => eq(tabla.slug, "demo"),
  });
  if (t === undefined) throw new Error("sin tenant demo en el seed");
  return t;
}

async function servicio30(db: Database, tenantId: string) {
  const s = await db.query.servicios.findFirst({
    where: and(eq(servicios.tenant_id, tenantId), eq(servicios.duracion_min, 30)),
  });
  if (s === undefined) throw new Error("sin servicio de 30 min en el seed");
  return s;
}

async function crearCliente(
  db: Database,
  tenantId: string,
  nombre: string,
  email: string,
  telefono: string | null = null,
) {
  const filas = await db
    .insert(clientes)
    .values({ tenant_id: tenantId, nombre, email, telefono, consentimiento: true })
    .returning();
  return filas[0]!;
}

async function insertarTurno(
  db: Database,
  datos: {
    tenant_id: string;
    cliente_id: string;
    servicio_id: string;
    inicio: Date;
    fin: Date;
    estado: TurnoEstado;
    token_hash?: string;
  },
) {
  const filas = await db
    .insert(turnos)
    .values({
      tenant_id: datos.tenant_id,
      cliente_id: datos.cliente_id,
      servicio_id: datos.servicio_id,
      token_hash:
        datos.token_hash ??
        randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
      fecha_hora_inicio: datos.inicio,
      fecha_hora_fin: datos.fin,
      estado: datos.estado,
    })
    .returning();
  return filas[0]!;
}

/** Inserta un evento de métricas con timestamp explícito (fixtures). */
async function insertarEvento(
  db: Database,
  datos: {
    tenant_id: string;
    turno_id: string;
    tipo: EventoTipo;
    payload?: Record<string, unknown>;
    origen?: EventoOrigen;
    timestamp_utc?: Date;
  },
) {
  const filas = await db
    .insert(eventosMetricas)
    .values({
      tenant_id: datos.tenant_id,
      turno_id: datos.turno_id,
      tipo: datos.tipo,
      payload: datos.payload ?? {},
      origen: datos.origen ?? EventoOrigen.Public,
      ...(datos.timestamp_utc === undefined
        ? {}
        : { timestamp_utc: datos.timestamp_utc }),
    })
    .returning();
  return filas[0]!;
}

async function contarEventos(
  db: Database,
  turnoId: string,
  tipo: EventoTipo,
): Promise<number> {
  const filas = await db
    .select({ id: eventosMetricas.evento_id })
    .from(eventosMetricas)
    .where(
      and(
        eq(eventosMetricas.turno_id, turnoId),
        eq(eventosMetricas.tipo, tipo),
      ),
    );
  return filas.length;
}

// --- Helpers puros (unidad) ---

describe("inicioSemanaISO / finSemanaISO — ventana ISO en la zona del negocio", () => {
  it("un instante a mitad de semana → lunes 00:00 local (zona del negocio)", () => {
    // 2026-09-30 (miércoles) → lunes 2026-09-28; 00:00 ART = 03:00Z.
    const inicio = inicioSemanaISO(
      new Date("2026-09-30T15:00:00.000Z"),
      TZ,
    );
    expect(inicio.toISOString()).toBe("2026-09-28T03:00:00.000Z");
  });

  it("triangulación: un lunes devuelve su propio lunes; fin = +7 días", () => {
    const lunes = inicioSemanaISO(new Date("2026-09-28T10:00:00.000Z"), TZ);
    expect(lunes.toISOString()).toBe("2026-09-28T03:00:00.000Z");
    expect(finSemanaISO(lunes, TZ).toISOString()).toBe(
      "2026-10-05T03:00:00.000Z",
    );
  });
});

describe("ratio — división segura (denominador 0 → null)", () => {
  it("5 ÷ 40 = 0.125; 1 ÷ 2 = 0.5", () => {
    expect(ratio(5, 40)).toBe(0.125);
    expect(ratio(1, 2)).toBe(0.5);
  });

  it("denominador 0 → null (KPI 2 sin datos)", () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(3, 0)).toBeNull();
  });
});

// --- Integración (BD de test + HTTP) ---

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "métricas y eventos — API (T-16)",
  () => {
    it("CA-MTE-01: cada transición escribe EXACTAMENTE 1 evento; confirmar duplicado no duplica (MTE-S2)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const tenant = await tenantDemo(db);
      const servicio = await servicio30(db, tenant.id);
      const cliente = await crearCliente(db, tenant.id, "Cadena", "cadena@example.com");

      // 1) Crear por API (público) → 1 reserva_creada.
      const fechaISO = (dias: number): string =>
        new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);
      const agenda = await app.inject({
        method: "GET",
        url: `/api/v1/agenda?servicio_id=${servicio.id}&desde=${fechaISO(0)}&hasta=${fechaISO(14)}`,
      });
      expect(agenda.statusCode).toBe(200);
      const dias = (
        agenda.json() as {
          dias: Array<{ slots: Array<{ slot_key: string; fecha_hora_inicio: string }> }>;
        }
      ).dias;
      const slots = dias
        .flatMap((d) => d.slots)
        .filter((s) => new Date(s.fecha_hora_inicio).getTime() > Date.now() + 200 * 60_000)
        .sort((a, b) => a.fecha_hora_inicio.localeCompare(b.fecha_hora_inicio));
      expect(slots.length).toBeGreaterThanOrEqual(2);

      const creada = await app.inject({
        method: "POST",
        url: "/api/v1/turnos",
        payload: {
          servicio_id: servicio.id,
          slot_key: slots[0]!.slot_key,
          cliente: { nombre: "Cadena", email: "cadena@example.com" },
          consentimiento: true,
        },
      });
      expect(creada.statusCode).toBe(201);
      const turnoId = (creada.json() as { turno_id: string }).turno_id;
      const token = (creada.json() as { enlace_gestion: string }).enlace_gestion
        .split("/")
        .pop()!;
      expect(await contarEventos(db, turnoId, EventoTipo.ReservaCreada)).toBe(1);

      // 2) Confirmar por enlace → 1 reserva_confirmada; repetir NO duplica.
      const conf1 = await app.inject({
        method: "POST",
        url: `/api/v1/turnos/${token}/confirmar`,
      });
      expect(conf1.statusCode).toBe(200);
      const conf2 = await app.inject({
        method: "POST",
        url: `/api/v1/turnos/${token}/confirmar`,
      });
      expect(conf2.statusCode).toBe(200);
      expect(await contarEventos(db, turnoId, EventoTipo.ReservaConfirmada)).toBe(1);

      // 3) Reagendar por enlace → 1 reagendulacion.
      const reag = await app.inject({
        method: "POST",
        url: `/api/v1/turnos/${token}/reagendar`,
        payload: { slot_key: slots[1]!.slot_key },
      });
      expect(reag.statusCode).toBe(200);
      expect(await contarEventos(db, turnoId, EventoTipo.Reagendulacion)).toBe(1);

      // 4) Cancelar desde el negocio → 1 cancelacion.
      const cookie = await login(app);
      const cancel = await app.inject({
        method: "POST",
        url: `/api/v1/turnos/${turnoId}/acciones`,
        headers: conCookie(cookie),
        payload: { accion: "cancelar", motivo: "prueba" },
      });
      expect(cancel.statusCode).toBe(200);
      expect(await contarEventos(db, turnoId, EventoTipo.Cancelacion)).toBe(1);

      // 5) Completado (turno pasado, ahora inyectado) → 1 completado.
      const pasado = new Date(Date.now() - 60 * 60_000);
      const tCompletar = await insertarTurno(db, {
        tenant_id: tenant.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        inicio: pasado,
        fin: new Date(pasado.getTime() + 30 * 60_000),
        estado: TurnoEstado.Confirmado,
      });
      await turnoService.accion(
        db,
        tenant.id,
        tCompletar.id,
        { accion: "completado", motivo: null },
        { ahora: new Date() },
      );
      expect(await contarEventos(db, tCompletar.id, EventoTipo.Completado)).toBe(1);

      // 6) No-show (inicio + 30 min, ahora inyectado) → 1 no_show.
      const tNoShow = await insertarTurno(db, {
        tenant_id: tenant.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        inicio: new Date(Date.now() - 2 * 60 * 60_000),
        fin: new Date(Date.now() - 90 * 60_000),
        estado: TurnoEstado.Confirmado,
      });
      await turnoService.accion(
        db,
        tenant.id,
        tNoShow.id,
        { accion: "no_show", motivo: null },
        { ahora: new Date() },
      );
      expect(await contarEventos(db, tNoShow.id, EventoTipo.NoShow)).toBe(1);

      await app.close();
    });

    it("eventoService.registrar: inserta EXACTAMENTE 1 evento con sus campos y tenant", async () => {
      const db = await prepararBd();
      const tenant = await tenantDemo(db);
      const servicio = await servicio30(db, tenant.id);
      const cliente = await crearCliente(db, tenant.id, "Evento", "evento@example.com");
      const turno = await insertarTurno(db, {
        tenant_id: tenant.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        inicio: new Date(Date.now() + 86_400_000),
        fin: new Date(Date.now() + 86_400_000 + 30 * 60_000),
        estado: TurnoEstado.Pendiente,
      });

      const fila = await eventoService.registrar(db, {
        tenant_id: tenant.id,
        turno_id: turno.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        tipo: EventoTipo.ReservaCreada,
        payload: { canal_contacto: "email" },
        origen: EventoOrigen.Public,
      });
      expect(fila.evento_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(fila.tipo).toBe("reserva_creada");
      expect(fila.tenant_id).toBe(tenant.id);
      expect(fila.payload).toEqual({ canal_contacto: "email" });
      expect(await contarEventos(db, turno.id, EventoTipo.ReservaCreada)).toBe(1);
    });

    it("MTE-S3: reservas_por_semana agrupa por semana ISO en la zona del negocio", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const tenant = await tenantDemo(db);
      const servicio = await servicio30(db, tenant.id);
      const cliente = await crearCliente(db, tenant.id, "ISO", "iso@example.com");
      const turno = await insertarTurno(db, {
        tenant_id: tenant.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        inicio: new Date(Date.now() + 86_400_000),
        fin: new Date(Date.now() + 86_400_000 + 30 * 60_000),
        estado: TurnoEstado.Pendiente,
      });

      // 2026-09-27 (domingo, W39, septiembre) y 2026-10-03 (sábado, W40,
      // octubre): semanas ISO distintas cruzando el cambio de mes.
      await insertarEvento(db, {
        tenant_id: tenant.id,
        turno_id: turno.id,
        tipo: EventoTipo.ReservaCreada,
        timestamp_utc: fromZonedTime("2026-09-27T12:00:00", TZ),
      });
      await insertarEvento(db, {
        tenant_id: tenant.id,
        turno_id: turno.id,
        tipo: EventoTipo.ReservaCreada,
        timestamp_utc: fromZonedTime("2026-10-03T12:00:00", TZ),
      });

      const cookie = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/metricas/resumen",
        headers: conCookie(cookie),
      });
      expect(res.statusCode).toBe(200);
      const cuerpo = res.json() as {
        reservas_por_semana: Array<{ semana: string; cantidad: number }>;
      };
      expect(cuerpo.reservas_por_semana).toEqual([
        { semana: "2026-40", cantidad: 1 },
        { semana: "2026-39", cantidad: 1 },
      ]);

      await app.close();
    });

    it("MTE-S1: tasa_no_show incluye el turno no-show en numerador y denominador", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const tenant = await tenantDemo(db);
      const servicio = await servicio30(db, tenant.id);
      const cliente = await crearCliente(db, tenant.id, "NoShow", "ns@example.com");
      const pasado = (dias: number): Date =>
        new Date(Date.now() - dias * 86_400_000);

      await insertarTurno(db, {
        tenant_id: tenant.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        inicio: pasado(2),
        fin: new Date(pasado(2).getTime() + 30 * 60_000),
        estado: TurnoEstado.NoShow,
      });
      await insertarTurno(db, {
        tenant_id: tenant.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        inicio: pasado(3),
        fin: new Date(pasado(3).getTime() + 30 * 60_000),
        estado: TurnoEstado.Completado,
      });

      const cookie = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/metricas/resumen",
        headers: conCookie(cookie),
      });
      expect(res.statusCode).toBe(200);
      // 1 no_show ÷ (1 completado + 1 no_show) = 0.5.
      expect((res.json() as { tasa_no_show: number }).tasa_no_show).toBe(0.5);

      // Triangulación: un completado más → 1 ÷ 3.
      await insertarTurno(db, {
        tenant_id: tenant.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        inicio: pasado(4),
        fin: new Date(pasado(4).getTime() + 30 * 60_000),
        estado: TurnoEstado.Completado,
      });
      const res2 = await app.inject({
        method: "GET",
        url: "/api/v1/metricas/resumen",
        headers: conCookie(cookie),
      });
      expect((res2.json() as { tasa_no_show: number }).tasa_no_show).toBeCloseTo(
        1 / 3,
        10,
      );

      await app.close();
    });

    it("MTE-S1b: sin turnos terminales post-fecha → tasa_no_show null (denominador 0)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const cookie = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/metricas/resumen",
        headers: conCookie(cookie),
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { tasa_no_show: number | null }).tasa_no_show).toBeNull();
      await app.close();
    });

    it("MTE-S4: ocupacion_semana = 5 ÷ 40 = 12.5 %; null sin horarios", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const tenant = await tenantDemo(db);
      const servicio = await servicio30(db, tenant.id);
      const cliente = await crearCliente(db, tenant.id, "Ocup", "ocup@example.com");

      // Fixture de un solo servicio: la capacidad es Σ slots por servicio, así
      // que se retiran los otros dos servicios del seed (45 y 60 min).
      await db
        .delete(servicios)
        .where(
          and(
            eq(servicios.tenant_id, tenant.id),
            inArray(servicios.duracion_min, [45, 60]),
          ),
        );

      // Horarios 9:00–13:00 (lun–vie): 8 slots/día × 5 días = 40.
      await db
        .delete(horariosRecurrentes)
        .where(eq(horariosRecurrentes.tenant_id, tenant.id));
      for (const dia of [1, 2, 3, 4, 5]) {
        await db.insert(horariosRecurrentes).values({
          tenant_id: tenant.id,
          dia_semana: dia,
          hora_inicio: "09:00:00",
          hora_fin: "13:00:00",
          timezone: TZ,
        });
      }

      // 5 turnos confirmados el lunes de la semana ISO ACTUAL.
      const lunes = inicioSemanaISO(new Date(), TZ);
      const inicio = new Date(lunes.getTime());
      for (const offsetMin of [0, 30, 60, 90, 120]) {
        await insertarTurno(db, {
          tenant_id: tenant.id,
          cliente_id: cliente.id,
          servicio_id: servicio.id,
          inicio: new Date(inicio.getTime() + offsetMin * 60_000),
          fin: new Date(inicio.getTime() + (offsetMin + 30) * 60_000),
          estado: TurnoEstado.Confirmado,
        });
      }

      const cookie = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/metricas/resumen",
        headers: conCookie(cookie),
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { ocupacion_semana: number }).ocupacion_semana).toBe(
        0.125,
      );

      // Triangulación: sin horarios → capacidad 0 → null.
      await db
        .delete(horariosRecurrentes)
        .where(eq(horariosRecurrentes.tenant_id, tenant.id));
      const res2 = await app.inject({
        method: "GET",
        url: "/api/v1/metricas/resumen",
        headers: conCookie(cookie),
      });
      expect(
        (res2.json() as { ocupacion_semana: number | null }).ocupacion_semana,
      ).toBeNull();

      await app.close();
    });

    it("KPI4: cancelaciones (cantidad + tasa) en 4 semanas", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const tenant = await tenantDemo(db);
      const servicio = await servicio30(db, tenant.id);
      const cliente = await crearCliente(db, tenant.id, "Cancel", "cancel@example.com");
      const turno = await insertarTurno(db, {
        tenant_id: tenant.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        inicio: new Date(Date.now() + 86_400_000),
        fin: new Date(Date.now() + 86_400_000 + 30 * 60_000),
        estado: TurnoEstado.Pendiente,
      });
      const hace = (dias: number): Date =>
        new Date(Date.now() - dias * 86_400_000);

      // 4 creadas + 1 cancelación dentro de las últimas 4 semanas.
      for (const dias of [1, 2, 3, 4]) {
        await insertarEvento(db, {
          tenant_id: tenant.id,
          turno_id: turno.id,
          tipo: EventoTipo.ReservaCreada,
          timestamp_utc: hace(dias),
        });
      }
      await insertarEvento(db, {
        tenant_id: tenant.id,
        turno_id: turno.id,
        tipo: EventoTipo.Cancelacion,
        timestamp_utc: hace(1),
      });

      const cookie = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/metricas/resumen",
        headers: conCookie(cookie),
      });
      expect(res.statusCode).toBe(200);
      expect(
        (res.json() as { cancelaciones: { cantidad: number; tasa: number } })
          .cancelaciones,
      ).toEqual({ cantidad: 1, tasa: 0.25 });

      // Triangulación: una cancelación más → cantidad 2, tasa 0.5.
      await insertarEvento(db, {
        tenant_id: tenant.id,
        turno_id: turno.id,
        tipo: EventoTipo.Cancelacion,
        timestamp_utc: hace(2),
      });
      const res2 = await app.inject({
        method: "GET",
        url: "/api/v1/metricas/resumen",
        headers: conCookie(cookie),
      });
      expect(
        (res2.json() as { cancelaciones: { cantidad: number; tasa: number } })
          .cancelaciones,
      ).toEqual({ cantidad: 2, tasa: 0.5 });

      await app.close();
    });

    it("CA-MTE-03: ningún evento contiene PII del cliente (auditoría)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const tenant = await tenantDemo(db);
      const servicio = await servicio30(db, tenant.id);
      const NOMBRE = "Ana PII Audit";
      const EMAIL = "ana.pii@example.com";
      const TELEFONO = "+54 11 4444-9999";

      const fechaISO = (dias: number): string =>
        new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);
      const agenda = await app.inject({
        method: "GET",
        url: `/api/v1/agenda?servicio_id=${servicio.id}&desde=${fechaISO(0)}&hasta=${fechaISO(14)}`,
      });
      const slot = (
        agenda.json() as {
          dias: Array<{ slots: Array<{ slot_key: string }> }>;
        }
      ).dias.flatMap((d) => d.slots)[0]!;
      const creada = await app.inject({
        method: "POST",
        url: "/api/v1/turnos",
        payload: {
          servicio_id: servicio.id,
          slot_key: slot.slot_key,
          cliente: { nombre: NOMBRE, email: EMAIL, telefono: TELEFONO },
          consentimiento: true,
        },
      });
      expect(creada.statusCode).toBe(201);

      const eventos = await db
        .select({ payload: eventosMetricas.payload })
        .from(eventosMetricas)
        .where(eq(eventosMetricas.tenant_id, tenant.id));
      expect(eventos.length).toBeGreaterThan(0);
      for (const evento of eventos) {
        const serializado = JSON.stringify(evento.payload);
        expect(serializado).not.toContain(NOMBRE);
        expect(serializado).not.toContain(EMAIL);
        expect(serializado).not.toContain(TELEFONO);
      }

      await app.close();
    });

    it("VNG-S7 + contrato: sin sesión → 401; con sesión → MetricasResumen con los 4 KPIs", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);

      const sinSesion = await app.inject({
        method: "GET",
        url: "/api/v1/metricas/resumen",
      });
      expect(sinSesion.statusCode).toBe(401);

      const cookie = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/metricas/resumen",
        headers: conCookie(cookie),
      });
      expect(res.statusCode).toBe(200);
      const cuerpo = res.json() as Record<string, unknown>;
      expect(Object.keys(cuerpo).sort()).toEqual([
        "cancelaciones",
        "ocupacion_semana",
        "reservas_por_semana",
        "tasa_no_show",
      ]);
      expect(Array.isArray(cuerpo.reservas_por_semana)).toBe(true);
      expect(typeof (cuerpo.cancelaciones as { tasa: number }).tasa).toBe("number");
      expect(typeof (cuerpo.cancelaciones as { cantidad: number }).cantidad).toBe(
        "number",
      );

      await app.close();
    });

    it("metricasService.resumen — service directo (KPI1 orden desc, 8 semanas)", async () => {
      const db = await prepararBd();
      const tenant = await tenantDemo(db);
      const servicio = await servicio30(db, tenant.id);
      const cliente = await crearCliente(db, tenant.id, "Directo", "directo@example.com");
      const turno = await insertarTurno(db, {
        tenant_id: tenant.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        inicio: new Date(Date.now() + 86_400_000),
        fin: new Date(Date.now() + 86_400_000 + 30 * 60_000),
        estado: TurnoEstado.Pendiente,
      });
      await insertarEvento(db, {
        tenant_id: tenant.id,
        turno_id: turno.id,
        tipo: EventoTipo.ReservaCreada,
        timestamp_utc: fromZonedTime("2026-09-27T12:00:00", TZ),
      });

      const resumen = await metricasService.resumen(db, {
        tenant_id: tenant.id,
        ahora: new Date(),
      });
      expect(resumen.reservas_por_semana).toEqual([
        { semana: "2026-39", cantidad: 1 },
      ]);
    });
  },
);
