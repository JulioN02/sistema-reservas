import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { TurnoEstado } from "@sistema-reservas/contracts";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";
import { createDb, type Database } from "../db";
import { seedDatabase } from "../db/seed";
import { clientes, servicios, turnos } from "../db/schema";
import { hashToken } from "../services/authService";

/**
 * Gestión de agenda del negocio (T-09) — capability agenda-disponibilidad,
 * con sesión obligatoria (T-07, RB-INT-03): horarios, bloques y servicios.
 *
 * Escenarios GWT de la spec:
 * - AGD-01: CRUD de horarios recurrentes vía API.
 * - AGD-02: CRUD de bloques de indisponibilidad vía API.
 * - AGD-04: CRUD de servicios + PATCH de parámetros vía API.
 * - RB-AGD-01: horario que solapa el mismo día → 409 (bajo lock tenant).
 * - AGD-S7 (EC-09): bloque que solapa turnos activos → 409 con detalle.
 * - CA-T09: 422 en parámetros fuera de rango; 401 sin sesión.
 *
 * Requiere PostgreSQL de test (TEST_DATABASE_URL; default db-test:5433).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/sistema_reservas_test";

const OPERADOR_EMAIL = "operador@demo.local";
const OPERADOR_PASSWORD = "demo-password-123";
const TZ_BA = "America/Argentina/Buenos_Aires";

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
    env: parseEnv({ DATABASE_URL: TEST_DATABASE_URL }),
    db,
    loggerOptions: { level: "silent" },
  });
}

/** Cookie `sid` de una sesión recién creada (helper de auth T-07). */
async function login(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: OPERADOR_EMAIL, password: OPERADOR_PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers["set-cookie"] as string[] | string | undefined;
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = /(?:^|;\s*)sid=([^;]+)/.exec(raw ?? "");
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

function cookie(token: string) {
  return { cookie: `sid=${token}` };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "gestión de agenda del negocio (T-09)",
  () => {
    it("401 sin sesión: GET/POST horarios, POST bloques, POST servicios y PATCH parametros exigen cookie (VNG-S7)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);

      const casos = [
        { method: "GET", url: "/api/v1/agenda/horarios" },
        {
          method: "POST",
          url: "/api/v1/agenda/horarios",
          payload: { dia_semana: 7, hora_inicio: "09:00", hora_fin: "12:00", timezone: TZ_BA },
        },
        {
          method: "POST",
          url: "/api/v1/agenda/bloques",
          payload: { fecha_inicio: "2026-10-05T03:00:00.000Z", fecha_fin: "2026-10-06T03:00:00.000Z" },
        },
        {
          method: "POST",
          url: "/api/v1/servicios",
          payload: { nombre: "Servicio X", duracion_min: 30 },
        },
        {
          method: "PATCH",
          url: "/api/v1/servicios/16f9d3d2-3a4b-4c5d-8e6f-1a2b3c4d5e6f/parametros",
          payload: { booking_window_days: 45 },
        },
      ] as const;

      for (const caso of casos) {
        const res = await app.inject({
          method: caso.method,
          url: caso.url,
          ...("payload" in caso ? { payload: caso.payload } : {}),
        });
        expect(res.statusCode, `${caso.method} ${caso.url}`).toBe(401);
        expect(res.headers["content-type"]).toContain(
          "application/problem+json",
        );
      }

      await app.close();
    });

    it("AGD-01 vía API: CRUD de horarios — POST 201, GET 200, PUT 200, DELETE 204, 404 con id desconocido", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const token = await login(app);
      const headers = cookie(token);

      // POST: domingo (sin horario en el seed) 09:00–12:00.
      const creado = await app.inject({
        method: "POST",
        url: "/api/v1/agenda/horarios",
        headers,
        payload: { dia_semana: 7, hora_inicio: "09:00", hora_fin: "12:00", timezone: TZ_BA },
      });
      expect(creado.statusCode).toBe(201);
      const horario = creado.json() as {
        id: string;
        dia_semana: number;
        hora_inicio: string;
        hora_fin: string;
        timezone: string;
        created_at: string;
      };
      expect(horario.id).toMatch(/^[0-9a-f-]{36}$/);
      // La hora se normaliza a HH:MM:SS (formato de la columna time).
      expect(horario.hora_inicio).toBe("09:00:00");
      expect(horario.hora_fin).toBe("12:00:00");
      expect(horario.timezone).toBe(TZ_BA);
      expect(horario.created_at).toBeTruthy();
      expect(Object.keys(horario)).not.toContain("tenant_id");

      // GET: la lista incluye el horario creado + los del seed.
      const lista = await app.inject({
        method: "GET",
        url: "/api/v1/agenda/horarios",
        headers,
      });
      expect(lista.statusCode).toBe(200);
      const horarios = lista.json() as Array<{ id: string }>;
      expect(
        horarios.some((h) => h.id === horario.id),
      ).toBe(true);

      // PUT: mueve a las 13:00–15:00 del mismo día.
      const actualizado = await app.inject({
        method: "PUT",
        url: `/api/v1/agenda/horarios/${horario.id}`,
        headers,
        payload: { dia_semana: 7, hora_inicio: "13:00", hora_fin: "15:00", timezone: TZ_BA },
      });
      expect(actualizado.statusCode).toBe(200);
      expect((actualizado.json() as { hora_inicio: string }).hora_inicio).toBe(
        "13:00:00",
      );

      // 404: id desconocido en PUT y DELETE.
      const idInexistente = "00000000-0000-4000-8000-000000000000";
      const put404 = await app.inject({
        method: "PUT",
        url: `/api/v1/agenda/horarios/${idInexistente}`,
        headers,
        payload: { dia_semana: 7, hora_inicio: "09:00", hora_fin: "12:00", timezone: TZ_BA },
      });
      expect(put404.statusCode).toBe(404);

      // DELETE → 204 y el recurso desaparece.
      const borrado = await app.inject({
        method: "DELETE",
        url: `/api/v1/agenda/horarios/${horario.id}`,
        headers,
      });
      expect(borrado.statusCode).toBe(204);

      const delete404 = await app.inject({
        method: "DELETE",
        url: `/api/v1/agenda/horarios/${horario.id}`,
        headers,
      });
      expect(delete404.statusCode).toBe(404);

      await app.close();
    });

    it("RB-AGD-01: horario que solapa otro del MISMO día → 409; contiguo al cierre o de otro día → 201/200", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const token = await login(app);
      const headers = cookie(token);

      // El seed tiene lun–vie 09:00–18:00: un lunes 08:00–10:00 solapa.
      const solapa = await app.inject({
        method: "POST",
        url: "/api/v1/agenda/horarios",
        headers,
        payload: { dia_semana: 1, hora_inicio: "08:00", hora_fin: "10:00", timezone: TZ_BA },
      });
      expect(solapa.statusCode).toBe(409);
      expect(solapa.headers["content-type"]).toContain(
        "application/problem+json",
      );

      // Contiguo al cierre (18:00–21:00 lunes) NO solapa → 201.
      const contiguo = await app.inject({
        method: "POST",
        url: "/api/v1/agenda/horarios",
        headers,
        payload: { dia_semana: 1, hora_inicio: "18:00", hora_fin: "21:00", timezone: TZ_BA },
      });
      expect(contiguo.statusCode).toBe(201);
      const idContiguo = (contiguo.json() as { id: string }).id;

      // PUT a un rango que solapa el seed → 409.
      const putSolapa = await app.inject({
        method: "PUT",
        url: `/api/v1/agenda/horarios/${idContiguo}`,
        headers,
        payload: { dia_semana: 1, hora_inicio: "16:00", hora_fin: "19:00", timezone: TZ_BA },
      });
      expect(putSolapa.statusCode).toBe(409);

      // PUT a un rango válido (18:30–21:00) → 200.
      const putOk = await app.inject({
        method: "PUT",
        url: `/api/v1/agenda/horarios/${idContiguo}`,
        headers,
        payload: { dia_semana: 1, hora_inicio: "18:30", hora_fin: "21:00", timezone: TZ_BA },
      });
      expect(putOk.statusCode).toBe(200);

      await app.close();
    });

    it("AGD-02 vía API: CRUD de bloques — POST 201, GET 200, DELETE 204, 404, 422 si fecha_fin < fecha_inicio", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const token = await login(app);
      const headers = cookie(token);

      const creado = await app.inject({
        method: "POST",
        url: "/api/v1/agenda/bloques",
        headers,
        payload: {
          fecha_inicio: "2026-10-05T03:00:00.000Z",
          fecha_fin: "2026-10-06T03:00:00.000Z",
          motivo: "Feriado",
        },
      });
      expect(creado.statusCode).toBe(201);
      const bloque = creado.json() as {
        id: string;
        fecha_inicio: string;
        fecha_fin: string;
        motivo: string | null;
      };
      expect(bloque.motivo).toBe("Feriado");
      expect(Object.keys(bloque)).not.toContain("tenant_id");

      const lista = await app.inject({
        method: "GET",
        url: "/api/v1/agenda/bloques",
        headers,
      });
      expect(lista.statusCode).toBe(200);
      expect(
        (lista.json() as Array<{ id: string }>).some((b) => b.id === bloque.id),
      ).toBe(true);

      const borrado = await app.inject({
        method: "DELETE",
        url: `/api/v1/agenda/bloques/${bloque.id}`,
        headers,
      });
      expect(borrado.statusCode).toBe(204);

      const delete404 = await app.inject({
        method: "DELETE",
        url: `/api/v1/agenda/bloques/${bloque.id}`,
        headers,
      });
      expect(delete404.statusCode).toBe(404);

      // 422: rango invertido (fecha_fin < fecha_inicio).
      const invertido = await app.inject({
        method: "POST",
        url: "/api/v1/agenda/bloques",
        headers,
        payload: {
          fecha_inicio: "2026-10-06T03:00:00.000Z",
          fecha_fin: "2026-10-05T03:00:00.000Z",
        },
      });
      expect(invertido.statusCode).toBe(422);
      expect(invertido.json().type).toContain("/validacion");

      await app.close();
    });

    it("AGD-S7 (EC-09): bloque que solapa turnos ACTIVOS → 409 con detalle de turnos afectados", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const token = await login(app);
      const headers = cookie(token);

      const tenant = await db.query.tenants.findFirst({
        where: (t) => eq(t.slug, "demo"),
      });
      if (tenant === undefined) throw new Error("sin tenant demo");
      const servicio = await db.query.servicios.findFirst({
        where: (t) => eq(t.tenant_id, tenant.id),
      });
      if (servicio === undefined) throw new Error("sin servicio seed");

      // Turno CONFIRMADO lunes 2026-10-05 10:00 local (13:00Z).
      const cliente = await db
        .insert(clientes)
        .values({
          tenant_id: tenant.id,
          nombre: "Cliente del bloque",
          email: "bloque@correo.test",
          consentimiento: true,
        })
        .returning();
      const turno = await db
        .insert(turnos)
        .values({
          tenant_id: tenant.id,
          cliente_id: cliente[0]!.id,
          servicio_id: servicio.id,
          token_hash: hashToken(randomBytes(32).toString("base64url")),
          fecha_hora_inicio: new Date("2026-10-05T13:00:00.000Z"),
          fecha_hora_fin: new Date("2026-10-05T13:30:00.000Z"),
          estado: TurnoEstado.Confirmado,
        })
        .returning({ id: turnos.id });

      // Bloque de todo el día → 409 con el id del turno afectado.
      const bloqueado = await app.inject({
        method: "POST",
        url: "/api/v1/agenda/bloques",
        headers,
        payload: {
          fecha_inicio: "2026-10-05T03:00:00.000Z",
          fecha_fin: "2026-10-06T03:00:00.000Z",
        },
      });
      expect(bloqueado.statusCode).toBe(409);
      expect(bloqueado.headers["content-type"]).toContain(
        "application/problem+json",
      );
      expect(bloqueado.json().detail).toContain(turno[0]!.id);

      // Un bloque que NO toca turnos (domingo sin turnos) → 201.
      const libre = await app.inject({
        method: "POST",
        url: "/api/v1/agenda/bloques",
        headers,
        payload: {
          fecha_inicio: "2026-10-11T03:00:00.000Z",
          fecha_fin: "2026-10-12T03:00:00.000Z",
        },
      });
      expect(libre.statusCode).toBe(201);

      await app.close();
    });

    it("AGD-04 vía API: CRUD de servicios + PATCH parámetros — 201/200/204 con rangos válidos", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const token = await login(app);
      const headers = cookie(token);

      const creado = await app.inject({
        method: "POST",
        url: "/api/v1/servicios",
        headers,
        payload: {
          nombre: "Sesión express",
          duracion_min: 15,
          precio: 12.5,
          booking_window_days: 20,
          cancellation_grace_minutes: 120,
        },
      });
      expect(creado.statusCode).toBe(201);
      const servicio = creado.json() as {
        id: string;
        nombre: string;
        duracion_min: number;
        precio: number | null;
        booking_window_days: number;
        cancellation_grace_minutes: number;
        activo: boolean;
      };
      expect(servicio.duracion_min).toBe(15);
      expect(servicio.precio).toBe(12.5);
      expect(servicio.booking_window_days).toBe(20);
      expect(servicio.cancellation_grace_minutes).toBe(120);
      expect(servicio.activo).toBe(true);
      expect(Object.keys(servicio)).not.toContain("tenant_id");

      // PATCH parámetros → 200 con la actualización reflejada.
      const patch = await app.inject({
        method: "PATCH",
        url: `/api/v1/servicios/${servicio.id}/parametros`,
        headers,
        payload: { booking_window_days: 45, activo: false },
      });
      expect(patch.statusCode).toBe(200);
      const patchBody = patch.json() as {
        booking_window_days: number;
        activo: boolean;
        cancellation_grace_minutes: number;
      };
      expect(patchBody.booking_window_days).toBe(45);
      expect(patchBody.activo).toBe(false);
      expect(patchBody.cancellation_grace_minutes).toBe(120); // intacto

      // PUT completo → 200.
      const put = await app.inject({
        method: "PUT",
        url: `/api/v1/servicios/${servicio.id}`,
        headers,
        payload: {
          nombre: "Sesión express XL",
          duracion_min: 30,
          precio: 18,
          booking_window_days: 30,
          cancellation_grace_minutes: 180,
          activo: true,
        },
      });
      expect(put.statusCode).toBe(200);
      expect((put.json() as { nombre: string }).nombre).toBe(
        "Sesión express XL",
      );

      // DELETE → 204; id desconocido → 404.
      const borrado = await app.inject({
        method: "DELETE",
        url: `/api/v1/servicios/${servicio.id}`,
        headers,
      });
      expect(borrado.statusCode).toBe(204);
      const delete404 = await app.inject({
        method: "DELETE",
        url: `/api/v1/servicios/${servicio.id}`,
        headers,
      });
      expect(delete404.statusCode).toBe(404);
      const put404 = await app.inject({
        method: "PUT",
        url: `/api/v1/servicios/${servicio.id}`,
        headers,
        payload: { nombre: "X", duracion_min: 30 },
      });
      expect(put404.statusCode).toBe(404);

      await app.close();
    });

    it("422: duración no múltiplo de 15 y parámetros fuera de rango (window > 90, gracia < 30) en POST y PATCH", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const token = await login(app);
      const headers = cookie(token);

      const duracionInvalida = await app.inject({
        method: "POST",
        url: "/api/v1/servicios",
        headers,
        payload: { nombre: "Raro", duracion_min: 20 },
      });
      expect(duracionInvalida.statusCode).toBe(422);
      expect(duracionInvalida.json().type).toContain("/validacion");
      const camposDuracion = (
        duracionInvalida.json().errores as Array<{ campo: string }>
      ).map((e) => e.campo);
      expect(camposDuracion).toContain("duracion_min");

      const windowFuera = await app.inject({
        method: "POST",
        url: "/api/v1/servicios",
        headers,
        payload: { nombre: "Ventana 91", duracion_min: 30, booking_window_days: 91 },
      });
      expect(windowFuera.statusCode).toBe(422);

      // PATCH con gracia fuera de rango → 422 con errores[].
      const servicio = await app.inject({
        method: "POST",
        url: "/api/v1/servicios",
        headers,
        payload: { nombre: "Base", duracion_min: 30 },
      });
      const id = (servicio.json() as { id: string }).id;

      const graciaCorta = await app.inject({
        method: "PATCH",
        url: `/api/v1/servicios/${id}/parametros`,
        headers,
        payload: { cancellation_grace_minutes: 29 },
      });
      expect(graciaCorta.statusCode).toBe(422);
      const camposGracia = (
        graciaCorta.json().errores as Array<{ campo: string }>
      ).map((e) => e.campo);
      expect(camposGracia).toContain("cancellation_grace_minutes");

      const graciaLarga = await app.inject({
        method: "PATCH",
        url: `/api/v1/servicios/${id}/parametros`,
        headers,
        payload: { cancellation_grace_minutes: 1441 },
      });
      expect(graciaLarga.statusCode).toBe(422);

      await app.close();
    });

    it("DELETE de un servicio con turnos asociados → 409 (integridad); sin turnos → 204", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const token = await login(app);
      const headers = cookie(token);

      const tenant = await db.query.tenants.findFirst({
        where: (t) => eq(t.slug, "demo"),
      });
      if (tenant === undefined) throw new Error("sin tenant demo");

      // Servicio nuevo + un turno asociado.
      const servicio = await db
        .insert(servicios)
        .values({
          tenant_id: tenant.id,
          nombre: "Con turnos",
          duracion_min: 30,
          booking_window_days: 30,
          cancellation_grace_minutes: 180,
        })
        .returning();
      const cliente = await db
        .insert(clientes)
        .values({
          tenant_id: tenant.id,
          nombre: "Cliente del servicio",
          email: "servicio@correo.test",
          consentimiento: true,
        })
        .returning();
      await db.insert(turnos).values({
        tenant_id: tenant.id,
        cliente_id: cliente[0]!.id,
        servicio_id: servicio[0]!.id,
        token_hash: hashToken(randomBytes(32).toString("base64url")),
        fecha_hora_inicio: new Date("2026-11-02T13:00:00.000Z"),
        fecha_hora_fin: new Date("2026-11-02T13:30:00.000Z"),
        estado: TurnoEstado.Confirmado,
      });

      const conTurnos = await app.inject({
        method: "DELETE",
        url: `/api/v1/servicios/${servicio[0]!.id}`,
        headers,
      });
      expect(conTurnos.statusCode).toBe(409);

      // Servicio sin turnos → 204.
      const simple = await db
        .insert(servicios)
        .values({
          tenant_id: tenant.id,
          nombre: "Sin turnos",
          duracion_min: 60,
        })
        .returning();
      const sinTurnos = await app.inject({
        method: "DELETE",
        url: `/api/v1/servicios/${simple[0]!.id}`,
        headers,
      });
      expect(sinTurnos.statusCode).toBe(204);

      await app.close();
    });

    it("GET /api/v1/servicios dual: sin sesión → ServicioPublico[]; con sesión → Servicio[] con parámetros", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const token = await login(app);

      const publico = await app.inject({ method: "GET", url: "/api/v1/servicios" });
      expect(publico.statusCode).toBe(200);
      const cuerpoPublico = publico.json() as Array<Record<string, unknown>>;
      expect(cuerpoPublico[0]).toBeDefined();
      expect(Object.keys(cuerpoPublico[0] ?? {})).not.toContain(
        "booking_window_days",
      );

      const negocio = await app.inject({
        method: "GET",
        url: "/api/v1/servicios",
        headers: cookie(token),
      });
      expect(negocio.statusCode).toBe(200);
      const cuerpoNegocio = negocio.json() as Array<Record<string, unknown>>;
      const primero = cuerpoNegocio[0];
      if (primero === undefined) throw new Error("sin servicios");
      expect(primero).toHaveProperty("booking_window_days");
      expect(primero).toHaveProperty("cancellation_grace_minutes");
      expect(primero).toHaveProperty("activo");
      expect(Object.keys(primero)).not.toContain("tenant_id");

      await app.close();
    });
  },
);