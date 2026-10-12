import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";
import { createDb, type Database } from "../db";
import { seedDatabase } from "../db/seed";
import { eventosMetricas, turnos } from "../db/schema";
import { hashToken, generarTokenOpaco } from "../services/authService";
import { enlaceExpirado, esEstadoTerminal } from "../services/turnoService";

/**
 * Confirmación por enlace + consulta de gestión (T-11) —
 * GET /api/v1/turnos/{token} y POST /api/v1/turnos/{token}/confirmar.
 *
 * Escenarios GWT de la spec (capability confirmacion-recordatorio):
 * - CMR-S1: 200 confirmado + evento reserva_confirmada (medio=enlace) en la
 *   MISMA tx; GET devuelve TurnoGestion {estado, servicio,
 *   fecha_hora_inicio/fin, cliente_nombre} (diseño §4.2, aditivo).
 * - CMR-S2/CA-CMR-01 (EC-11): doble confirmación → 2×200 y EXACTAMENTE 1
 *   evento reserva_confirmada (idempotencia RB-CMR-02).
 * - CMR-S3 (EC-11): token inexistente/malformado → 404 genérico idéntico en
 *   ambos casos, sin revelar la existencia del turno (RB-INT-02).
 * - Terminal (cancelado/completado/no_show) y expirado (7 días post-cita,
 *   RB-CMR-01) → 410 Gone sin datos.
 * - CA-CMR-02: token 32 B base64url = 256 bits ≥ 128 (formato/longitud).
 * - CA-CMR-04: el enlace confirma sin depender del email (fallback, EC-10).
 *
 * Requiere PostgreSQL de test (TEST_DATABASE_URL; override local 5437).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5437/sistema_reservas_test";

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

/** Primer slot libre con inicio ≥ ahora + `minAheadMs`. */
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

/** Servicio del seed por duración (default 30 min), con su nombre. */
async function primerServicio(
  app: FastifyInstance,
  duracionMin = 30,
): Promise<{ id: string; duracion_min: number; nombre: string }> {
  const res = await app.inject({ method: "GET", url: "/api/v1/servicios" });
  expect(res.statusCode).toBe(200);
  const servicios = res.json() as Array<{
    id: string;
    duracion_min: number;
    nombre: string;
  }>;
  const servicio = servicios.find((s) => s.duracion_min === duracionMin);
  if (servicio === undefined) {
    throw new Error(`sin servicio de ${duracionMin} min en seed`);
  }
  return servicio;
}

/** Crea una reserva 201 y devuelve {turno_id, enlace_gestion, estado}. */
async function reservar(
  app: FastifyInstance,
  servicioId: string,
  cliente: Record<string, string>,
): Promise<{ turno_id: string; enlace_gestion: string; estado: string }> {
  const slot = await primerSlotLibre(app, servicioId);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/turnos",
    payload: {
      servicio_id: servicioId,
      slot_key: slot.slot_key,
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

async function confirmar(app: FastifyInstance, token: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/turnos/${token}/confirmar`,
  });
}

async function obtenerGestion(app: FastifyInstance, token: string) {
  return app.inject({ method: "GET", url: `/api/v1/turnos/${token}` });
}

async function eventosConfirmacion(
  db: Database,
  turnoId: string,
): Promise<unknown[]> {
  return db
    .select()
    .from(eventosMetricas)
    .where(
      and(
        eq(eventosMetricas.turno_id, turnoId),
        eq(eventosMetricas.tipo, "reserva_confirmada"),
      ),
    );
}

// --- Helpers puros (unidad) ---

describe("CA-CMR-02 — token de enlace ≥ 128 bits (RB-CMR-01)", () => {
  it("generarTokenOpaco: 43 caracteres base64url (32 bytes = 256 bits), sin padding", () => {
    const token = generarTokenOpaco();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 43 chars base64url sin padding decodifican exactamente 32 bytes.
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("tokens únicos entre llamadas y hash sha256 de 64 hex en BD", () => {
    const tokens = [generarTokenOpaco(), generarTokenOpaco(), generarTokenOpaco()];
    expect(new Set(tokens).size).toBe(3);
    expect(hashToken(tokens[0]!)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(tokens[0]!)).not.toBe(tokens[0]);
  });
});

describe("esEstadoTerminal — máquina de estados (spec §11)", () => {
  it("cancelado, completado y no_show son terminales", () => {
    expect(esEstadoTerminal("cancelado")).toBe(true);
    expect(esEstadoTerminal("completado")).toBe(true);
    expect(esEstadoTerminal("no_show")).toBe(true);
  });

  it("pendiente y confirmado NO son terminales (siguen activos)", () => {
    expect(esEstadoTerminal("pendiente")).toBe(false);
    expect(esEstadoTerminal("confirmado")).toBe(false);
  });
});

describe("enlaceExpirado — vigencia del token (RB-CMR-01, 7 días post-cita)", () => {
  it("turno con fecha hace 8 días → expirado; hace 6 días → vigente", () => {
    const inicio = new Date("2026-10-01T12:00:00.000Z");
    const ahora = new Date("2026-10-09T12:00:00.000Z"); // inicio + 8 días
    expect(enlaceExpirado(inicio, ahora)).toBe(true);
    const ahora6 = new Date("2026-10-07T12:00:00.000Z"); // inicio + 6 días
    expect(enlaceExpirado(inicio, ahora6)).toBe(false);
  });

  it("turno futuro o exactamente 7 días después → no expirado / expirado (borde)", () => {
    const inicio = new Date("2026-10-01T12:00:00.000Z");
    expect(enlaceExpirado(inicio, new Date("2026-09-30T12:00:00.000Z"))).toBe(
      false,
    );
    // Borde: exactamente 7 días después — la vigencia termina ahí (RB-CMR-01).
    expect(enlaceExpirado(inicio, new Date("2026-10-08T12:00:00.000Z"))).toBe(
      true,
    );
  });
});

// --- Integración (BD de test + HTTP) ---

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "confirmación por enlace — GET /turnos/{token} y POST /turnos/{token}/confirmar (T-11)",
  () => {
    it("CMR-S1: GET devuelve TurnoGestion sin tenant_id; confirmar → 200 + estado confirmado + 1 evento reserva_confirmada {medio: enlace} en la misma tx", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const creada = await reservar(app, servicio.id, {
        nombre: "Laura Pérez",
        email: "laura@example.com",
      });

      // GET /turnos/{token} → TurnoGestion (diseño §4.2, aditivo).
      const token = tokenDe(creada.enlace_gestion);
      const gestion = await obtenerGestion(app, token);
      expect(gestion.statusCode).toBe(200);
      const cuerpo = gestion.json() as Record<string, unknown>;
      // Contrato: exactamente {estado, servicio, servicio_id, zona_horaria,
      // fecha_hora_inicio, fecha_hora_fin, cliente_nombre} — sin tenant_id
      // (CA-INT-04). servicio_id + zona_horaria permiten resolver el contexto
      // del turno por id (no por nombre) en la SPA.
      expect(Object.keys(cuerpo).sort()).toEqual([
        "cliente_nombre",
        "estado",
        "fecha_hora_fin",
        "fecha_hora_inicio",
        "servicio",
        "servicio_id",
        "zona_horaria",
      ]);
      expect(cuerpo.estado).toBe("pendiente");
      expect(cuerpo.servicio).toBe(servicio.nombre);
      expect(cuerpo.servicio_id).toBe(servicio.id);
      expect(cuerpo.zona_horaria).toBe("America/Argentina/Buenos_Aires");
      expect(cuerpo.cliente_nombre).toBe("Laura Pérez");
      // Sin fuga de tenant_id en la respuesta pública (CA-INT-04).
      expect(cuerpo).not.toHaveProperty("tenant_id");

      // POST confirmar → 200 {turno_id, estado: confirmado}.
      const confirmado = await confirmar(app, token);
      expect(confirmado.statusCode).toBe(200);
      expect(confirmado.json()).toEqual({
        turno_id: creada.turno_id,
        estado: "confirmado",
      });

      // Estado persistido + evento en la misma transacción (CA-MTE-01).
      const turno = await db.query.turnos.findFirst({
        where: eq(turnos.id, creada.turno_id),
      });
      expect(turno?.estado).toBe("confirmado");
      const eventos = await eventosConfirmacion(db, creada.turno_id);
      expect(eventos).toHaveLength(1);
      const evento = eventos[0] as {
        origen: string;
        payload: { medio: string };
      };
      expect(evento.origen).toBe("public");
      expect(evento.payload.medio).toBe("enlace");

      // GET posterior refleja el nuevo estado.
      const despues = await obtenerGestion(app, token);
      expect(despues.statusCode).toBe(200);
      expect((despues.json() as { estado: string }).estado).toBe("confirmado");

      await app.close();
    });

    it("TurnoGestion.servicio_id refleja el servicio reservado (no hardcode): servicio de 45 min", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app, 45);
      const creada = await reservar(app, servicio.id, {
        nombre: "Sofía Luna",
        email: "sofia@example.com",
      });

      const token = tokenDe(creada.enlace_gestion);
      const gestion = await obtenerGestion(app, token);
      expect(gestion.statusCode).toBe(200);
      const cuerpo = gestion.json() as Record<string, unknown>;
      // Triangulación: el id/zona vienen del turno reservado, no del seed 30 min.
      expect(cuerpo.servicio_id).toBe(servicio.id);
      expect(cuerpo.servicio).toBe(servicio.nombre);
      expect(cuerpo.zona_horaria).toBe("America/Argentina/Buenos_Aires");

      await app.close();
    });

    it("CMR-S2/CA-CMR-01 (EC-11): doble confirmación → 2×200 y EXACTAMENTE 1 evento reserva_confirmada", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const creada = await reservar(app, servicio.id, {
        nombre: "Marcos Díaz",
        email: "marcos@example.com",
      });
      const token = tokenDe(creada.enlace_gestion);

      const primera = await confirmar(app, token);
      expect(primera.statusCode).toBe(200);
      const segunda = await confirmar(app, token);
      expect(segunda.statusCode).toBe(200);
      expect(segunda.json()).toEqual({
        turno_id: creada.turno_id,
        estado: "confirmado",
      });

      // RB-CMR-02: la segunda confirmación NO genera evento duplicado.
      const eventos = await eventosConfirmacion(db, creada.turno_id);
      expect(eventos).toHaveLength(1);

      await app.close();
    });

    it("CMR-S3 (EC-11): token inexistente y token malformado → 404 problem+json IDÉNTICO en GET y POST (sin revelar existencia)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);

      const desconocido = generarTokenOpaco();
      const malformado = "abc";

      for (const url of [
        `/api/v1/turnos/${desconocido}`,
        `/api/v1/turnos/${malformado}`,
      ]) {
        const get = await app.inject({ method: "GET", url });
        expect(get.statusCode).toBe(404);
        expect(get.headers["content-type"]).toContain("application/problem+json");
        expect((get.json() as { type: string }).type).toContain(
          "/no-encontrado",
        );
      }
      // Misma respuesta para token desconocido y malformado (CMR-S3): el
      // único campo que difiere es `instance` de RFC 7807, que ecoa la URL
      // de la petición (distinta por construcción) — type/title/detail/status
      // son idénticos y genéricos, sin revelar la existencia del turno.
      const sinInstance = (
        cuerpo: Record<string, unknown>,
      ): Record<string, unknown> => {
        const { instance: _instance, ...rest } = cuerpo;
        return rest;
      };
      const desconocidoGet = await app.inject({
        method: "GET",
        url: `/api/v1/turnos/${desconocido}`,
      });
      const malformadoGet = await app.inject({
        method: "GET",
        url: `/api/v1/turnos/${malformado}`,
      });
      expect(sinInstance(malformadoGet.json())).toEqual(
        sinInstance(desconocidoGet.json()),
      );

      const desconocidoPost = await confirmar(app, desconocido);
      const malformadoPost = await confirmar(app, malformado);
      expect(desconocidoPost.statusCode).toBe(404);
      expect(sinInstance(malformadoPost.json())).toEqual(
        sinInstance(desconocidoPost.json()),
      );

      expect(await db.select().from(turnos)).toHaveLength(0);

      await app.close();
    });

    it("RB-CMR-01: estado terminal (cancelado/completado/no_show) → 410 Gone sin datos y sin evento", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);

      for (const terminal of ["cancelado", "completado", "no_show"] as const) {
        const creada = await reservar(app, servicio.id, {
          nombre: `Terminal ${terminal}`,
          email: `terminal-${terminal}@example.com`,
        });
        await db
          .update(turnos)
          .set({ estado: terminal, updated_at: new Date() })
          .where(eq(turnos.id, creada.turno_id));
        const token = tokenDe(creada.enlace_gestion);

        // Simular el business con estado terminal (T-14 aún no implementado).
        const gestion = await obtenerGestion(app, token);
        expect(gestion.statusCode).toBe(410);
        expect((gestion.json() as { type: string }).type).toContain("/expirado");

        const confirmado = await confirmar(app, token);
        expect(confirmado.statusCode).toBe(410);

        // Los rechazos jamás emiten reserva_confirmada (exactamente-1).
        expect(await eventosConfirmacion(db, creada.turno_id)).toHaveLength(0);
      }

      await app.close();
    });

    it("RB-CMR-01: expirado (8 días post-cita) → 410; dentro de la ventana (6 días) → vigente y confirmable", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);

      // Expirado: cita hace 8 días (> 7 días de vigencia).
      const expirada = await reservar(app, servicio.id, {
        nombre: "Nora Ruiz",
        email: "nora@example.com",
      });
      const hace8Dias = new Date(Date.now() - 8 * 86_400_000);
      await db
        .update(turnos)
        .set({
          fecha_hora_inicio: hace8Dias,
          fecha_hora_fin: new Date(hace8Dias.getTime() + 30 * 60_000),
          updated_at: new Date(),
        })
        .where(eq(turnos.id, expirada.turno_id));
      const tokenExpirada = tokenDe(expirada.enlace_gestion);
      const gestionExpirada = await obtenerGestion(app, tokenExpirada);
      expect(gestionExpirada.statusCode).toBe(410);
      const confirmarExpirada = await confirmar(app, tokenExpirada);
      expect(confirmarExpirada.statusCode).toBe(410);

      // Vigente: cita hace 6 días (dentro de los 7 días post-cita).
      const vigente = await reservar(app, servicio.id, {
        nombre: "Omar Vega",
        email: "omar@example.com",
      });
      const hace6Dias = new Date(Date.now() - 6 * 86_400_000);
      await db
        .update(turnos)
        .set({
          fecha_hora_inicio: hace6Dias,
          fecha_hora_fin: new Date(hace6Dias.getTime() + 30 * 60_000),
          updated_at: new Date(),
        })
        .where(eq(turnos.id, vigente.turno_id));
      const tokenVigente = tokenDe(vigente.enlace_gestion);
      const gestionVigente = await obtenerGestion(app, tokenVigente);
      expect(gestionVigente.statusCode).toBe(200);
      expect((gestionVigente.json() as { estado: string }).estado).toBe(
        "pendiente",
      );
      const confirmarVigente = await confirmar(app, tokenVigente);
      expect(confirmarVigente.statusCode).toBe(200);

      await app.close();
    });

    it("CA-CMR-04 (EC-10): enlace funciona sin email — cliente solo teléfono confirma 200", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const creada = await reservar(app, servicio.id, {
        nombre: "Paula Sosa",
        telefono: "+54 11 5555-0333",
      });

      // Sin email: el recordatorio se programa con canal log (RB-RST-04) pero
      // el enlace de gestión es el fallback siempre disponible (RB-CMR-06).
      const token = tokenDe(creada.enlace_gestion);
      const gestion = await obtenerGestion(app, token);
      expect(gestion.statusCode).toBe(200);
      expect((gestion.json() as { estado: string }).estado).toBe("pendiente");

      const confirmado = await confirmar(app, token);
      expect(confirmado.statusCode).toBe(200);
      expect((confirmado.json() as { estado: string }).estado).toBe(
        "confirmado",
      );
      expect(await eventosConfirmacion(db, creada.turno_id)).toHaveLength(1);

      await app.close();
    });
  },
);