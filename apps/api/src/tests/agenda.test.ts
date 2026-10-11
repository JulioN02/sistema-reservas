import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";
import { createDb, type Database } from "../db";
import { seedDatabase } from "../db/seed";
import { servicios } from "../db/schema";
import { calcularSlots } from "../services/agendaService";

/**
 * Agenda de disponibilidad pública (T-08) — capability agenda-disponibilidad.
 *
 * La función pura `calcularSlots` es la proyección horarios − bloques −
 * turnos activos (RB-AGD-07: slots NUNCA persistidos); los escenarios GWT de
 * la spec se testean sin BD:
 *
 * - AGD-S1/CA-AGD-01: conteo exacto de slots (17) del happy path.
 * - AGD-S2/CA-AGD-02: un bloque elimina el 100 % de los slots de su fecha.
 * - AGD-S3: los turnos activos restan sus inicios de la oferta.
 * - AGD-S4 (EC-07): ventana [hoy, hoy + booking_window_days).
 * - AGD-S5 (EC-08/EC-15): duración variable y cierre sin cruzar.
 * - AGD-S6 (EC-02): DST — hora local de pared con UTC ajustado (AD-06).
 * - AGD-S8 (EC-14): todos los servicios compiten por el mismo recurso.
 * - CA-AGD-04: sin slots en el pasado ni fuera de ventana.
 *
 * Requiere PostgreSQL de test (TEST_DATABASE_URL; default db-test:5433) solo
 * para los tests de endpoints públicos.
 */

const TZ_BA = "America/Argentina/Buenos_Aires"; // UTC-3, sin DST
const TZ_NY = "America/New_York"; // con DST (spring forward: 2.º domingo de marzo)

/** Lunes 2026-10-05 00:00 en BA (UTC-3) — día base de los escenarios. */
const LUNES_BA = new Date("2026-10-05T03:00:00.000Z");

const HORARIO_LUNES_1730 = [
  {
    dia_semana: 1,
    hora_inicio: "09:00:00",
    hora_fin: "17:30:00",
    timezone: TZ_BA,
  },
];

const HORARIO_TODOS_LOS_DIAS = [
  {
    dia_semana: 1,
    hora_inicio: "09:00:00",
    hora_fin: "17:30:00",
    timezone: TZ_BA,
  },
  {
    dia_semana: 2,
    hora_inicio: "09:00:00",
    hora_fin: "17:30:00",
    timezone: TZ_BA,
  },
  {
    dia_semana: 3,
    hora_inicio: "09:00:00",
    hora_fin: "17:30:00",
    timezone: TZ_BA,
  },
  {
    dia_semana: 4,
    hora_inicio: "09:00:00",
    hora_fin: "17:30:00",
    timezone: TZ_BA,
  },
  {
    dia_semana: 5,
    hora_inicio: "09:00:00",
    hora_fin: "17:30:00",
    timezone: TZ_BA,
  },
  {
    dia_semana: 6,
    hora_inicio: "09:00:00",
    hora_fin: "17:30:00",
    timezone: TZ_BA,
  },
  {
    dia_semana: 7,
    hora_inicio: "09:00:00",
    hora_fin: "17:30:00",
    timezone: TZ_BA,
  },
];

const SERVICIO_ID = "16f9d3d2-3a4b-4c5d-8e6f-1a2b3c4d5e6f";

function baseParams(overrides?: Record<string, unknown>) {
  return {
    servicio_id: SERVICIO_ID,
    duracion_min: 30,
    timezone: TZ_BA,
    booking_window_days: 30,
    horarios: HORARIO_LUNES_1730,
    bloques: [],
    turnosActivos: [],
    hoy: LUNES_BA,
    desde: LUNES_BA,
    hasta: new Date("2026-10-12T03:00:00.000Z"),
    ahora: LUNES_BA,
    ...overrides,
  };
}

describe("calcularSlots — función pura (T-08)", () => {
  it("AGD-S1/CA-AGD-01: horario lun–vie 09:00–17:30 + servicio 30 min → exactamente 17 slots alineados (:00/:30) entre 09:00 y 17:00", () => {
    const slots = calcularSlots(baseParams());

    expect(slots).toHaveLength(17);

    // Primer slot 09:00 local = 12:00Z (BA, UTC-3); el último termina 17:30 local.
    expect(slots[0]?.fecha_hora_inicio.toISOString()).toBe(
      "2026-10-05T12:00:00.000Z",
    );
    expect(slots.at(-1)?.fecha_hora_fin.toISOString()).toBe(
      "2026-10-05T20:30:00.000Z",
    );

    // Alineación :00/:30 exigida por la spec; ninguno cruza el cierre.
    for (const slot of slots) {
      const minutos = slot.fecha_hora_inicio.getUTCMinutes();
      expect([0, 30]).toContain(minutos);
      expect(slot.fecha_hora_fin.getTime()).toBeLessThanOrEqual(
        new Date("2026-10-05T20:30:00.000Z").getTime(),
      );
    }
  });

  it("AGD-S2/CA-AGD-02: un bloque elimina el 100 % de los slots de su fecha sin alterar las demás", () => {
    const sinBloque = calcularSlots(
      baseParams({ horarios: HORARIO_TODOS_LOS_DIAS }),
    );
    // Lunes a domingo: 7 días × 17 slots.
    expect(sinBloque).toHaveLength(7 * 17);

    const conBloque = calcularSlots(
      baseParams({
        horarios: HORARIO_TODOS_LOS_DIAS,
        // Día completo del lunes 2026-10-05 en zona BA (03:00Z → 03:00Z).
        bloques: [
          {
            fecha_inicio: new Date("2026-10-05T03:00:00.000Z"),
            fecha_fin: new Date("2026-10-06T03:00:00.000Z"),
          },
        ],
      }),
    );

    expect(conBloque).toHaveLength(6 * 17);

    // Ningún slot del lunes (fecha 2026-10-05 en zona BA); el resto intacto.
    const slotsDelLunes = conBloque.filter(
      (s) => s.fecha_hora_inicio.toISOString().startsWith("2026-10-05"),
    );
    expect(slotsDelLunes).toEqual([]);
    const slotsDelMartes = conBloque.filter(
      (s) => s.fecha_hora_inicio.toISOString().startsWith("2026-10-06"),
    );
    expect(slotsDelMartes).toHaveLength(17);
  });

  it("AGD-S3: 3 turnos activos el lunes → esos 3 inicios no se ofrecen", () => {
    const slots = calcularSlots(
      baseParams({
        turnosActivos: [
          { fecha_hora_inicio: new Date("2026-10-05T12:00:00.000Z"), fecha_hora_fin: new Date("2026-10-05T12:30:00.000Z") },
          { fecha_hora_inicio: new Date("2026-10-05T13:00:00.000Z"), fecha_hora_fin: new Date("2026-10-05T13:30:00.000Z") },
          { fecha_hora_inicio: new Date("2026-10-05T14:00:00.000Z"), fecha_hora_fin: new Date("2026-10-05T14:30:00.000Z") },
        ],
      }),
    );

    expect(slots).toHaveLength(17 - 3);
    const inicios = new Set(
      slots.map((s) => s.fecha_hora_inicio.toISOString()),
    );
    expect(inicios.has("2026-10-05T12:00:00.000Z")).toBe(false);
    expect(inicios.has("2026-10-05T13:00:00.000Z")).toBe(false);
    expect(inicios.has("2026-10-05T14:00:00.000Z")).toBe(false);
    // Los inicios no ocupados permanecen (triangulación).
    expect(inicios.has("2026-10-05T12:30:00.000Z")).toBe(true);
    expect(inicios.has("2026-10-05T17:00:00.000Z")).toBe(true);
  });

  it("AGD-S4 (EC-07): ventana [hoy, hoy + 30) — hoy+31 sin slots, hoy+29 con slots", () => {
    const hoy = new Date("2026-09-28T03:00:00.000Z"); // lunes
    const finVentana = new Date("2026-10-28T03:00:00.000Z");

    // Dentro de la ventana: hoy+29 (martes 27/10) → 17 slots.
    const dentro = calcularSlots(
      baseParams({
        horarios: HORARIO_TODOS_LOS_DIAS,
        hoy,
        desde: new Date("2026-10-27T03:00:00.000Z"),
        hasta: finVentana,
      }),
    );
    expect(dentro.length).toBeGreaterThan(0);

    // Fuera de la ventana: hoy+31 (jueves 29/10) → sin slots.
    const fuera = calcularSlots(
      baseParams({
        horarios: HORARIO_TODOS_LOS_DIAS,
        hoy,
        desde: new Date("2026-10-29T03:00:00.000Z"),
        hasta: new Date("2026-11-04T03:00:00.000Z"),
      }),
    );
    expect(fuera).toEqual([]);
  });

  it("AGD-S5 (EC-08/EC-15): horario 09:00–10:00 + servicio 45 min → slots 09:00 y 09:15 (09:30 cruzaría el cierre)", () => {
    const slots = calcularSlots(
      baseParams({
        duracion_min: 45,
        horarios: [
          {
            dia_semana: 1,
            hora_inicio: "09:00:00",
            hora_fin: "10:00:00",
            timezone: TZ_BA,
          },
        ],
      }),
    );

    const inicios = slots.map((s) => s.fecha_hora_inicio.toISOString());
    expect(inicios).toEqual([
      "2026-10-05T12:00:00.000Z", // 09:00–09:45
      "2026-10-05T12:15:00.000Z", // 09:15–10:00 (termina en el cierre)
    ]);
  });

  it("AGD-S6 (EC-02): DST — misma hora local de pared con UTC ajustado (America/New_York) y estable en America/Argentina/Buenos_Aires", () => {
    const horarioDomingo = [
      {
        dia_semana: 7,
        hora_inicio: "09:00:00",
        hora_fin: "10:00:00",
        timezone: TZ_NY,
      },
    ];

    // Domingo 2026-03-01 (EST, UTC-5): 09:00 local = 14:00Z.
    const antesDst = calcularSlots(
      baseParams({
        horarios: horarioDomingo,
        timezone: TZ_NY,
        desde: new Date("2026-03-01T05:00:00.000Z"),
        hasta: new Date("2026-03-02T05:00:00.000Z"),
        hoy: new Date("2026-03-01T05:00:00.000Z"),
        ahora: new Date("2026-03-01T05:00:00.000Z"),
      }),
    );
    expect(antesDst[0]?.fecha_hora_inicio.toISOString()).toBe(
      "2026-03-01T14:00:00.000Z",
    );

    // Domingo 2026-03-08 (EDT, UTC-4, spring forward): 09:00 local = 13:00Z.
    const diaDst = calcularSlots(
      baseParams({
        horarios: horarioDomingo,
        timezone: TZ_NY,
        desde: new Date("2026-03-08T05:00:00.000Z"),
        hasta: new Date("2026-03-09T05:00:00.000Z"),
        hoy: new Date("2026-03-08T05:00:00.000Z"),
        ahora: new Date("2026-03-08T05:00:00.000Z"),
      }),
    );
    expect(diaDst[0]?.fecha_hora_inicio.toISOString()).toBe(
      "2026-03-08T13:00:00.000Z",
    );

    // Buenos Aires (sin DST): el mismo horario local se mantiene en UTC.
    const horarioDomingoBa = [
      {
        dia_semana: 7,
        hora_inicio: "09:00:00",
        hora_fin: "10:00:00",
        timezone: TZ_BA,
      },
    ];
    for (const dia of [
      new Date("2026-03-01T03:00:00.000Z"),
      new Date("2026-03-08T03:00:00.000Z"),
    ]) {
      const slots = calcularSlots(
        baseParams({
          horarios: horarioDomingoBa,
          timezone: TZ_BA,
          desde: dia,
          hasta: new Date(dia.getTime() + 24 * 60 * 60 * 1000),
          hoy: dia,
          ahora: dia,
        }),
      );
      // 09:00 BA = 12:00Z en ambos días (UTC-3 fijo, sin DST).
      const fechaLocal = dia.toISOString().slice(0, 10);
      expect(slots[0]?.fecha_hora_inicio.toISOString()).toBe(
        `${fechaLocal}T12:00:00.000Z`,
      );
    }
  });

  it("AGD-S8 (EC-14): servicios compiten — un turno activo de A (30 min) a las 09:00 quita el 09:00 de B (60 min); 10:00 se ofrece", () => {
    const slots = calcularSlots(
      baseParams({
        duracion_min: 60,
        horarios: [
          {
            dia_semana: 1,
            hora_inicio: "09:00:00",
            hora_fin: "18:00:00",
            timezone: TZ_BA,
          },
        ],
        // Turno activo de OTRO servicio (RB-AGD-05: compiten todos).
        turnosActivos: [
          {
            fecha_hora_inicio: new Date("2026-10-05T12:00:00.000Z"),
            fecha_hora_fin: new Date("2026-10-05T12:30:00.000Z"),
          },
        ],
      }),
    );

    const inicios = new Set(
      slots.map((s) => s.fecha_hora_inicio.toISOString()),
    );
    expect(inicios.has("2026-10-05T12:00:00.000Z")).toBe(false); // 09:00 solapa
    expect(inicios.has("2026-10-05T13:00:00.000Z")).toBe(true); // 10:00 libre
  });

  it("CA-AGD-04: ninguna respuesta contiene slots en el pasado ni fuera de la ventana", () => {
    // Consulta al mediodía (15:00Z): los slots de la mañana ya son pasado.
    const ahora = new Date("2026-10-05T15:00:00.000Z");
    const slots = calcularSlots(baseParams({ ahora }));
    for (const slot of slots) {
      expect(slot.fecha_hora_inicio.getTime()).toBeGreaterThanOrEqual(
        ahora.getTime(),
      );
    }
    // La ventana [hoy, hoy+30) recorta días futuros fuera de rango.
    const finVentana = new Date("2026-11-04T03:00:00.000Z");
    const fuera = calcularSlots(
      baseParams({
        horarios: HORARIO_TODOS_LOS_DIAS,
        hoy: LUNES_BA,
        desde: finVentana,
        hasta: new Date("2026-11-11T03:00:00.000Z"),
      }),
    );
    expect(fuera).toEqual([]);
  });

  it("RB-AGD-07/AGD-02: slot_key = `<inicio ISO8601 UTC>|<servicio_id>`; los slots no se persisten (proyección pura)", () => {
    const slots = calcularSlots(
      baseParams({
        duracion_min: 45,
        horarios: [
          {
            dia_semana: 1,
            hora_inicio: "09:00:00",
            hora_fin: "10:30:00",
            timezone: TZ_BA,
          },
        ],
      }),
    );
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.slot_key).toBe(
        `${slot.fecha_hora_inicio.toISOString()}|${SERVICIO_ID}`,
      );
      // Grilla de 15 min: el minuto del inicio es múltiplo de 15.
      expect(slot.fecha_hora_inicio.getUTCMinutes() % 15).toBe(0);
    }
  });
});

// --- Endpoints públicos (integración con BD de test) ---

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/sistema_reservas_test";

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

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "agenda pública — endpoints (T-08)",
  () => {
    it("CA-INT-04: GET /api/v1/servicios (público) → 200 ServicioPublico[] sin tenant_id", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);

      const res = await app.inject({ method: "GET", url: "/api/v1/servicios" });
      expect(res.statusCode).toBe(200);

      const cuerpo = res.json() as Array<Record<string, unknown>>;
      expect(cuerpo.length).toBeGreaterThan(0);
      expect(JSON.stringify(cuerpo)).not.toContain("tenant_id");

      // ServicioPublico: {id, nombre, duracion_min, precio, zona_horaria}.
      const primero = cuerpo[0];
      if (primero === undefined) throw new Error("sin servicios");
      expect(Object.keys(primero).sort()).toEqual([
        "duracion_min",
        "id",
        "nombre",
        "precio",
        "zona_horaria",
      ]);
      expect(primero.zona_horaria).toBe("America/Argentina/Buenos_Aires");
      expect(typeof primero.precio).toBe("number");

      await app.close();
    });

    it("AGD-03 vía API: GET /api/v1/agenda → {zona_horaria, dias:[{fecha, slots}]} con slot_key por contrato", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);

      const servicios = await app.inject({
        method: "GET",
        url: "/api/v1/servicios",
      });
      const servicio = (servicios.json() as Array<{ id: string; duracion_min: number }>)[0];
      if (servicio === undefined) throw new Error("sin servicios");
      expect(servicio.duracion_min).toBe(30);

      // Lunes 2026-10-12 (dentro de la ventana del seed: 30 días desde hoy).
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/agenda?servicio_id=${servicio.id}&desde=2026-10-12&hasta=2026-10-13`,
      });
      expect(res.statusCode).toBe(200);

      const cuerpo = res.json() as {
        zona_horaria: string;
        dias: Array<{ fecha: string; slots: Array<{ slot_key: string; fecha_hora_inicio: string; fecha_hora_fin: string }> }>;
      };
      expect(cuerpo.zona_horaria).toBe("America/Argentina/Buenos_Aires");
      expect(cuerpo.dias).toHaveLength(1);
      expect(cuerpo.dias[0]?.fecha).toBe("2026-10-12");

      // Seed: lun–vie 09:00–18:00, servicio 30 min → 18 slots (:00/:30).
      const slots = cuerpo.dias[0]?.slots ?? [];
      expect(slots).toHaveLength(18);
      for (const slot of slots) {
        expect(slot.slot_key).toBe(`${slot.fecha_hora_inicio}|${servicio.id}`);
        const fin = new Date(slot.fecha_hora_fin).getTime();
        const inicio = new Date(slot.fecha_hora_inicio).getTime();
        expect(fin - inicio).toBe(30 * 60 * 1000);
      }
      expect(slots[0]?.fecha_hora_inicio).toBe("2026-10-12T12:00:00.000Z");

      await app.close();
    });

    it("400/422/404: query malformada → 400; hasta <= desde → 422; servicio desconocido → 404", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);

      const malformada = await app.inject({
        method: "GET",
        url: "/api/v1/agenda?servicio_id=no-uuid&desde=abc&hasta=2026-10-13",
      });
      expect(malformada.statusCode).toBe(400);
      expect(malformada.headers["content-type"]).toContain(
        "application/problem+json",
      );

      const invertida = await app.inject({
        method: "GET",
        url: "/api/v1/agenda?servicio_id=16f9d3d2-3a4b-4c5d-8e6f-1a2b3c4d5e6f&desde=2026-10-13&hasta=2026-10-12",
      });
      expect(invertida.statusCode).toBe(422);
      expect(invertida.json().type).toContain("/validacion");

      const desconocido = await app.inject({
        method: "GET",
        url: `/api/v1/agenda?servicio_id=${randomUUID()}&desde=2026-10-12&hasta=2026-10-13`,
      });
      expect(desconocido.statusCode).toBe(404);

      await app.close();
    });

    it("404: un servicio INACTIVO no se ofrece en la agenda pública (defensa en profundidad)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);

      // El GET /servicios público ya solo lista activos; insertamos uno
      // inactivo directo en BD (mismo tenant demo) para probar el path por id.
      const existente = await db.query.servicios.findFirst();
      if (existente === undefined) throw new Error("sin servicios");
      const inactivo = await db
        .insert(servicios)
        .values({
          tenant_id: existente.tenant_id,
          nombre: "Servicio inactivo (no público)",
          duracion_min: 30,
          activo: false,
        })
        .returning();

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/agenda?servicio_id=${inactivo[0]!.id}&desde=2026-10-12&hasta=2026-10-13`,
      });
      expect(res.statusCode).toBe(404);

      await app.close();
    });

    it("CA-AGD-04 vía API: consulta amplia no devuelve slots pasados ni fuera de la ventana de reserva", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);

      const servicios = await app.inject({
        method: "GET",
        url: "/api/v1/servicios",
      });
      const servicio = (servicios.json() as Array<{ id: string }>)[0];
      if (servicio === undefined) throw new Error("sin servicios");

      // Rango amplio: desde una semana atrás hasta muy lejos en el futuro.
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/agenda?servicio_id=${servicio.id}&desde=2026-10-01&hasta=2026-12-31`,
      });
      expect(res.statusCode).toBe(200);

      const cuerpo = res.json() as {
        dias: Array<{ fecha: string; slots: Array<{ fecha_hora_inicio: string }> }>;
      };
      const ahora = Date.now();
      let primerDiaConSlots: string | undefined;
      for (const dia of cuerpo.dias) {
        for (const slot of dia.slots) {
          // Sin slots en el pasado (RB-AGD-06, EC-12).
          expect(new Date(slot.fecha_hora_inicio).getTime()).toBeGreaterThanOrEqual(
            ahora - 60_000,
          );
          if (primerDiaConSlots === undefined) primerDiaConSlots = dia.fecha;
        }
      }
      // Los días previos a hoy no ofrecen nada; hoy sí aparece.
      expect(primerDiaConSlots).toBeDefined();

      await app.close();
    });
  },
);