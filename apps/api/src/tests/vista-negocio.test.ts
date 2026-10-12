import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fromZonedTime } from "date-fns-tz";
import type { FastifyInstance } from "fastify";
import { TurnoEstado } from "@sistema-reservas/contracts";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";
import { createDb, type Database } from "../db";
import { seedDatabase } from "../db/seed";
import { clientes, servicios, tenants, turnos } from "../db/schema";
import {
  esUuid,
  parsearAgendaDiaQuery,
  parsearHistorialQuery,
} from "../dto/turnos";
import { BadRequestError, ValidationError } from "../infra/errors";
import { generarTokenOpaco, hashToken } from "../services/authService";
import { aTurnoDetalle, aTurnoResumen } from "../services/turnoService";

/**
 * Vista negocio API (T-15) — capability vista-negocio.
 *
 * Escenarios GWT de la spec:
 * - VNG-S3: vista del día → lista cronológica con hora local, cliente,
 *   servicio y estado (RB-VNG-01: "hoy"/horas en la zona del negocio).
 * - VNG-S6/CA-VNG-04: historial filtrado por estado + rango de fechas →
 *   subconjunto EXACTO, ordenado desc (RB-VNG-02/index de hot path).
 * - INT-S1: GET de un turno de OTRO tenant → 404 idéntico al inexistente
 *   (sin filtrar datos ni revelar existencia).
 * - VNG-S7: sin sesión → 401 en los tres endpoints de negocio.
 * - Dispatch del path compartido `/turnos/{param}`: token público → TurnoGestion;
 *   id + sesión → TurnoDetalle (Fastify no admite dos rutas con el mismo
 *   patrón `/turnos/:x`).
 *
 * Contrato: TurnoResumen (agenda/dia + turnos list) y TurnoDetalle (turnos/{id}).
 * Requiere PostgreSQL de test (TEST_DATABASE_URL; override local 5437).
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

async function tenantDemo(db: Database) {
  const t = await db.query.tenants.findFirst({ where: eq(tenants.slug, "demo") });
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
) {
  const filas = await db
    .insert(clientes)
    .values({ tenant_id: tenantId, nombre, email, consentimiento: true })
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

function conCookie(cookie: string): { cookie: string } {
  return { cookie: `sid=${cookie}` };
}

/** Copia un problem+json sin el campo `instance` (la URL de la request). */
function sinInstance(body: unknown): Record<string, unknown> {
  const copia = { ...(body as Record<string, unknown>) };
  delete copia.instance;
  return copia;
}

// --- Helpers puros (unidad) ---

describe("parsearAgendaDiaQuery — vista del día (VNG-01)", () => {
  it("fecha válida → la devuelve tal cual", () => {
    expect(parsearAgendaDiaQuery({ fecha: "2026-03-10" })).toEqual({
      fecha: "2026-03-10",
    });
  });

  it("falta fecha o formato inválido → 400 (BadRequestError)", () => {
    expect(() => parsearAgendaDiaQuery({})).toThrow(BadRequestError);
    expect(() => parsearAgendaDiaQuery({ fecha: "10/03/2026" })).toThrow(
      BadRequestError,
    );
  });

  it("formato correcto pero día inexistente (2026-02-30) → 422 (ValidationError)", () => {
    expect(() => parsearAgendaDiaQuery({ fecha: "2026-02-30" })).toThrow(
      ValidationError,
    );
  });
});

describe("parsearHistorialQuery — historial filtrable (VNG-02/VNG-S6)", () => {
  it("sin filtros → campos undefined", () => {
    const q = parsearHistorialQuery({});
    expect(q.estado).toBeUndefined();
    expect(q.desde).toBeUndefined();
    expect(q.hasta).toBeUndefined();
  });

  it("estado + rango ISO → normaliza las fechas a Date", () => {
    const q = parsearHistorialQuery({
      estado: "cancelado",
      desde: "2026-02-08T00:00:00.000Z",
      hasta: "2026-02-22T00:00:00.000Z",
    });
    expect(q.estado).toBe("cancelado");
    expect(q.desde?.toISOString()).toBe("2026-02-08T00:00:00.000Z");
    expect(q.hasta?.toISOString()).toBe("2026-02-22T00:00:00.000Z");
  });

  it("estado fuera del enum → 422 (ValidationError)", () => {
    expect(() => parsearHistorialQuery({ estado: "foo" })).toThrow(
      ValidationError,
    );
  });

  it("desde con formato inválido → 422 (ValidationError)", () => {
    expect(() => parsearHistorialQuery({ desde: "ayer" })).toThrow(
      ValidationError,
    );
  });
});

describe("esUuid — discriminación token vs id en /turnos/{param}", () => {
  it("uuid → true; token base64url → false", () => {
    expect(esUuid("3f1c9b2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f")).toBe(true);
    expect(esUuid("abCDef0123456789abCDef0123456789abCDef01234")).toBe(false);
  });
});

describe("aTurnoResumen / aTurnoDetalle — mapeo al contrato", () => {
  const inicio = new Date("2026-03-10T12:00:00.000Z");
  const fin = new Date("2026-03-10T12:30:00.000Z");

  it("aTurnoResumen → ISO + campos del contrato (TurnoResumen)", () => {
    expect(
      aTurnoResumen({
        id: "t1",
        estado: TurnoEstado.Confirmado,
        cliente_nombre: "Ana",
        servicio_nombre: "Consulta general",
        fecha_hora_inicio: inicio,
        fecha_hora_fin: fin,
      }),
    ).toEqual({
      id: "t1",
      estado: "confirmado",
      cliente_nombre: "Ana",
      servicio_nombre: "Consulta general",
      fecha_hora_inicio: "2026-03-10T12:00:00.000Z",
      fecha_hora_fin: "2026-03-10T12:30:00.000Z",
    });
  });

  it("aTurnoDetalle → anida cliente/servicio, precio numérico y fechas ISO", () => {
    expect(
      aTurnoDetalle({
        id: "t1",
        estado: TurnoEstado.Cancelado,
        motivo: "cliente",
        fecha_hora_inicio: inicio,
        fecha_hora_fin: fin,
        cliente_nombre: "Ana",
        cliente_email: "ana@example.com",
        cliente_telefono: null,
        servicio_id: "s1",
        servicio_nombre: "Consulta general",
        servicio_duracion_min: 30,
        servicio_precio: "25.00",
        created_at: inicio,
        updated_at: fin,
      }),
    ).toEqual({
      id: "t1",
      estado: "cancelado",
      motivo: "cliente",
      fecha_hora_inicio: "2026-03-10T12:00:00.000Z",
      fecha_hora_fin: "2026-03-10T12:30:00.000Z",
      cliente: { nombre: "Ana", email: "ana@example.com", telefono: null },
      servicio: {
        id: "s1",
        nombre: "Consulta general",
        duracion_min: 30,
        precio: 25,
      },
      created_at: "2026-03-10T12:00:00.000Z",
      updated_at: "2026-03-10T12:30:00.000Z",
    });
  });
});

// --- Integración (BD de test + HTTP) ---

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "vista negocio — API (T-15)",
  () => {
    it("VNG-S3: GET /agenda/dia → turnos del día local cronológicos con cliente/servicio/estado (RB-VNG-01)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const tenant = await tenantDemo(db);
      const servicio = await servicio30(db, tenant.id);
      const cliente = await crearCliente(
        db,
        tenant.id,
        "Ana Vista",
        "ana.vista@example.com",
      );

      const t1 = await insertarTurno(db, {
        tenant_id: tenant.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        inicio: fromZonedTime("2026-03-10T09:00:00", TZ),
        fin: fromZonedTime("2026-03-10T09:30:00", TZ),
        estado: TurnoEstado.Confirmado,
      });
      // Insertado fuera de orden a propósito: la API debe ordenar cronológico.
      const t2 = await insertarTurno(db, {
        tenant_id: tenant.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        inicio: fromZonedTime("2026-03-10T11:00:00", TZ),
        fin: fromZonedTime("2026-03-10T11:30:00", TZ),
        estado: TurnoEstado.Pendiente,
      });
      const t3 = await insertarTurno(db, {
        tenant_id: tenant.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        inicio: fromZonedTime("2026-03-10T10:00:00", TZ),
        fin: fromZonedTime("2026-03-10T10:30:00", TZ),
        estado: TurnoEstado.Completado,
      });
      // Otro día: NO debe aparecer en la vista del 2026-03-10.
      const t4 = await insertarTurno(db, {
        tenant_id: tenant.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        inicio: fromZonedTime("2026-03-11T09:00:00", TZ),
        fin: fromZonedTime("2026-03-11T09:30:00", TZ),
        estado: TurnoEstado.Confirmado,
      });

      const cookie = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/agenda/dia?fecha=2026-03-10",
        headers: conCookie(cookie),
      });
      expect(res.statusCode).toBe(200);
      const cuerpo = res.json() as Array<{ id: string }>;
      expect(cuerpo.map((t) => t.id)).toEqual([t1.id, t3.id, t2.id]);
      expect(cuerpo[0]).toEqual({
        id: t1.id,
        estado: "confirmado",
        cliente_nombre: "Ana Vista",
        servicio_nombre: servicio.nombre,
        fecha_hora_inicio: fromZonedTime("2026-03-10T09:00:00", TZ).toISOString(),
        fecha_hora_fin: fromZonedTime("2026-03-10T09:30:00", TZ).toISOString(),
      });

      // Triangulación: otro día → solo su turno.
      const res2 = await app.inject({
        method: "GET",
        url: "/api/v1/agenda/dia?fecha=2026-03-11",
        headers: conCookie(cookie),
      });
      expect(res2.statusCode).toBe(200);
      const otroDia = res2.json() as Array<{ id: string }>;
      expect(otroDia.map((t) => t.id)).toEqual([t4.id]);

      await app.close();
    });

    it("VNG-S6/CA-VNG-04: GET /turnos filtra por estado + rango y ordena desc (subconjunto exacto)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const tenant = await tenantDemo(db);
      const servicio = await servicio30(db, tenant.id);
      const cliente = await crearCliente(
        db,
        tenant.id,
        "Historial",
        "historial@example.com",
      );

      const base = {
        tenant_id: tenant.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
      };
      const h1 = await insertarTurno(db, {
        ...base,
        inicio: fromZonedTime("2026-01-05T09:00:00", TZ),
        fin: fromZonedTime("2026-01-05T09:30:00", TZ),
        estado: TurnoEstado.Cancelado,
      });
      const h2 = await insertarTurno(db, {
        ...base,
        inicio: fromZonedTime("2026-02-10T09:00:00", TZ),
        fin: fromZonedTime("2026-02-10T09:30:00", TZ),
        estado: TurnoEstado.Cancelado,
      });
      const h3 = await insertarTurno(db, {
        ...base,
        inicio: fromZonedTime("2026-02-15T09:00:00", TZ),
        fin: fromZonedTime("2026-02-15T09:30:00", TZ),
        estado: TurnoEstado.Confirmado,
      });
      const h4 = await insertarTurno(db, {
        ...base,
        inicio: fromZonedTime("2026-02-20T09:00:00", TZ),
        fin: fromZonedTime("2026-02-20T09:30:00", TZ),
        estado: TurnoEstado.Completado,
      });
      const h5 = await insertarTurno(db, {
        ...base,
        inicio: fromZonedTime("2026-03-01T09:00:00", TZ),
        fin: fromZonedTime("2026-03-01T09:30:00", TZ),
        estado: TurnoEstado.Cancelado,
      });

      const cookie = await login(app);
      const rango =
        "desde=2026-02-08T00:00:00.000Z&hasta=2026-02-22T00:00:00.000Z";
      const ids = async (url: string): Promise<string[]> => {
        const res = await app.inject({
          method: "GET",
          url,
          headers: conCookie(cookie),
        });
        expect(res.statusCode).toBe(200);
        return (res.json() as Array<{ id: string }>).map((t) => t.id);
      };

      // CA-VNG-04: cancelados del rango → exactamente h2.
      expect(
        await ids(`/api/v1/turnos?estado=cancelado&${rango}`),
      ).toEqual([h2.id]);
      // Triangulación: confirmados del rango → exactamente h3.
      expect(
        await ids(`/api/v1/turnos?estado=confirmado&${rango}`),
      ).toEqual([h3.id]);
      // Sin estado → los 3 del rango, orden desc.
      expect(await ids(`/api/v1/turnos?${rango}`)).toEqual([
        h4.id,
        h3.id,
        h2.id,
      ]);
      // Sin filtros → los 5, orden desc.
      expect(await ids("/api/v1/turnos")).toEqual([
        h5.id,
        h4.id,
        h3.id,
        h2.id,
        h1.id,
      ]);

      await app.close();
    });

    it("INT-S1: GET /turnos/{id} de otro tenant → 404 idéntico a inexistente (sin leak)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const tenantA = await tenantDemo(db);
      const servicioA = await servicio30(db, tenantA.id);
      const clienteA = await crearCliente(
        db,
        tenantA.id,
        "Cliente A",
        "a@example.com",
      );
      const turnoA = await insertarTurno(db, {
        tenant_id: tenantA.id,
        cliente_id: clienteA.id,
        servicio_id: servicioA.id,
        inicio: fromZonedTime("2026-03-10T09:00:00", TZ),
        fin: fromZonedTime("2026-03-10T09:30:00", TZ),
        estado: TurnoEstado.Confirmado,
      });

      // Tenant B con su propio servicio/cliente/turno.
      const tenantB = (
        await db
          .insert(tenants)
          .values({ slug: "otro-negocio", nombre: "Otro Negocio", timezone: TZ })
          .returning()
      )[0]!;
      const servicioB = (
        await db
          .insert(servicios)
          .values({
            tenant_id: tenantB.id,
            nombre: "Servicio B",
            duracion_min: 30,
            booking_window_days: 30,
            cancellation_grace_minutes: 180,
            activo: true,
          })
          .returning()
      )[0]!;
      const clienteB = await crearCliente(
        db,
        tenantB.id,
        "Cliente B",
        "b@example.com",
      );
      const turnoB = await insertarTurno(db, {
        tenant_id: tenantB.id,
        cliente_id: clienteB.id,
        servicio_id: servicioB.id,
        inicio: fromZonedTime("2026-03-10T10:00:00", TZ),
        fin: fromZonedTime("2026-03-10T10:30:00", TZ),
        estado: TurnoEstado.Pendiente,
      });

      const cookie = await login(app);

      // Propio → 200 TurnoDetalle (contrato).
      const propio = await app.inject({
        method: "GET",
        url: `/api/v1/turnos/${turnoA.id}`,
        headers: conCookie(cookie),
      });
      expect(propio.statusCode).toBe(200);
      expect(propio.json()).toEqual({
        id: turnoA.id,
        estado: "confirmado",
        motivo: null,
        fecha_hora_inicio: fromZonedTime(
          "2026-03-10T09:00:00",
          TZ,
        ).toISOString(),
        fecha_hora_fin: fromZonedTime("2026-03-10T09:30:00", TZ).toISOString(),
        cliente: { nombre: "Cliente A", email: "a@example.com", telefono: null },
        servicio: {
          id: servicioA.id,
          nombre: servicioA.nombre,
          duracion_min: 30,
          precio: 25,
        },
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });

      // Ajeno → 404; inexistente → 404 con el MISMO cuerpo (sin revelar).
      const ajeno = await app.inject({
        method: "GET",
        url: `/api/v1/turnos/${turnoB.id}`,
        headers: conCookie(cookie),
      });
      expect(ajeno.statusCode).toBe(404);
      const inexistente = await app.inject({
        method: "GET",
        url: `/api/v1/turnos/${randomUUID()}`,
        headers: conCookie(cookie),
      });
      expect(inexistente.statusCode).toBe(404);
      // Mismo problem+json salvo `instance` (que es la URL de la request).
      expect(sinInstance(ajeno.json())).toEqual(sinInstance(inexistente.json()));
      expect((ajeno.json() as { title: string }).title).toBe("No encontrado");

      await app.close();
    });

    it("VNG-S7: sin sesión → 401 en GET /turnos, GET /agenda/dia y GET /turnos/{id}", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);

      const lista = await app.inject({ method: "GET", url: "/api/v1/turnos" });
      expect(lista.statusCode).toBe(401);
      const dia = await app.inject({
        method: "GET",
        url: "/api/v1/agenda/dia?fecha=2026-03-10",
      });
      expect(dia.statusCode).toBe(401);
      const detalle = await app.inject({
        method: "GET",
        url: `/api/v1/turnos/${randomUUID()}`,
      });
      expect(detalle.statusCode).toBe(401);

      await app.close();
    });

    it("dispatch /turnos/{param}: token (público) → TurnoGestion; id + sesión → TurnoDetalle", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const tenant = await tenantDemo(db);
      const servicio = await servicio30(db, tenant.id);
      const cliente = await crearCliente(
        db,
        tenant.id,
        "Eva Enlace",
        "eva@example.com",
      );
      const token = generarTokenOpaco();
      const futuro = new Date(Date.now() + 3 * 86_400_000);
      const turno = await insertarTurno(db, {
        tenant_id: tenant.id,
        cliente_id: cliente.id,
        servicio_id: servicio.id,
        inicio: futuro,
        fin: new Date(futuro.getTime() + 30 * 60_000),
        estado: TurnoEstado.Pendiente,
        token_hash: hashToken(token),
      });

      // Enlace público sin sesión → 200 TurnoGestion (contrato /turnos/{token}).
      const publico = await app.inject({
        method: "GET",
        url: `/api/v1/turnos/${token}`,
      });
      expect(publico.statusCode).toBe(200);
      const gestion = publico.json() as {
        estado: string;
        servicio_id: string;
        zona_horaria: string;
        cliente_nombre: string;
      };
      expect(gestion).toMatchObject({
        estado: "pendiente",
        servicio_id: servicio.id,
        zona_horaria: TZ,
        cliente_nombre: "Eva Enlace",
      });

      // Mismo path, id + sesión → 200 TurnoDetalle (contrato /turnos/{id}).
      const cookie = await login(app);
      const negocio = await app.inject({
        method: "GET",
        url: `/api/v1/turnos/${turno.id}`,
        headers: conCookie(cookie),
      });
      expect(negocio.statusCode).toBe(200);
      expect(negocio.json()).toMatchObject({
        id: turno.id,
        estado: "pendiente",
        cliente: { nombre: "Eva Enlace" },
      });

      await app.close();
    });
  },
);
