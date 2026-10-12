import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import {
  EventoTipo,
  RecordatorioCanal,
  RecordatorioEstado,
  TurnoEstado,
} from "@sistema-reservas/contracts";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";
import { createDb, type Database } from "../db";
import { seedDatabase } from "../db/seed";
import { eventosMetricas, recordatorios, turnos } from "../db/schema";
import { calcularProgramadoPara } from "../services/turnoService";
import type {
  Notificacion,
  NotificationChannel,
  ResultadoEnvio,
} from "../notificaciones/channel";
import { LogChannel } from "../notificaciones/logChannel";
import { EmailChannel, construirEmail } from "../notificaciones/emailChannel";
import {
  NotificationService,
  crearNotificationService,
  resolverCanal,
} from "../notificaciones/notificationService";
import {
  BACKOFF_MINUTOS,
  MAX_INTENTOS,
  detenerScheduler,
  iniciarScheduler,
  siguienteProgramadoPara,
  sweep,
  turnoNoEnviable,
} from "../notificaciones/reminderScheduler";

/**
 * NotificationService + ReminderScheduler (T-12) — capability
 * confirmacion-recordatorio (diseño §6, spec §5/§13).
 *
 * Escenarios GWT:
 * - CMR-S4 (EC-10): proveedor caído → reintentos 5/15/60 min; al agotar
 *   (intentos = 3) → estado fallido + evento recordatorio_fallido; el enlace
 *   sigue funcionando como fallback.
 * - CMR-S5 (lead corto): reserva dentro del lead → recordatorio inmediato
 *   (programado_para = ahora), recogido por el sweep en la misma corrida.
 * - CMR-S6: turno cancelado → recordatorio programado pasa a cancelado, sin
 *   envío ni evento de recordatorio.
 * - CMR-S7: turno pendiente con fecha pasada → no se envía post-cita; el
 *   recordatorio pasa a cancelado y el turno queda pendiente.
 *
 * Criterios de aceptación:
 * - CA-CMR-03: todo recordatorio se resuelve (enviado/fallido) con
 *   `intentos <= 3`.
 * - CA-CMR-05: los eventos recordatorio_enviado/fallido quedan correlacionados
 *   por turno_id.
 *
 * Requiere PostgreSQL de test (TEST_DATABASE_URL; override local 5437).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5437/sistema_reservas_test";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

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

// --- Dobles de prueba (canales + logger) ---

interface LoggerEspia {
  logger: { info: (obj: Record<string, unknown>, msg?: string) => void };
  llamadas: Array<{ obj: Record<string, unknown>; msg?: string }>;
}

function loggerEspia(): LoggerEspia {
  const llamadas: LoggerEspia["llamadas"] = [];
  return {
    llamadas,
    logger: {
      info: (obj, msg) => {
        llamadas.push(msg === undefined ? { obj } : { obj, msg });
      },
    },
  };
}

interface CanalEspia {
  canal: NotificationChannel;
  llamadas: Notificacion[];
}

function canalEspia(resultado: ResultadoEnvio = { ok: true }): CanalEspia {
  const llamadas: Notificacion[] = [];
  return {
    llamadas,
    canal: {
      enviar: async (notificacion) => {
        llamadas.push(notificacion);
        return resultado;
      },
    },
  };
}

function notificacionBase(overrides: Partial<Notificacion> = {}): Notificacion {
  return {
    canal: RecordatorioCanal.Email,
    destinatario: "cliente@example.com",
    cliente_nombre: "Laura Pérez",
    servicio: "Consulta general",
    // 2026-10-15T13:00Z = 10:00 en America/Argentina/Buenos_Aires (UTC-3).
    fecha_hora_inicio: new Date("2026-10-15T13:00:00.000Z"),
    timezone: "America/Argentina/Buenos_Aires",
    enlace: "/g/token-de-prueba",
    lead_min: 1440,
    intento: 1,
    ...overrides,
  };
}

// --- Unidad: canales ---

describe("LogChannel — canal de desarrollo (diseño §6.1)", () => {
  it("registra el email que se habría enviado y devuelve éxito", async () => {
    const espia = loggerEspia();
    const canal = new LogChannel(espia.logger);
    const resultado = await canal.enviar(notificacionBase());

    expect(resultado).toEqual({ ok: true });
    expect(espia.llamadas).toHaveLength(1);
    const registro = espia.llamadas[0]!.obj;
    expect(registro.channel).toBe("log");
    expect(registro.to).toBe("cliente@example.com");
    expect(registro.enlace).toBe("/g/token-de-prueba");
  });

  it("sin destinatario también devuelve éxito (no hay red que falle)", async () => {
    const espia = loggerEspia();
    const canal = new LogChannel(espia.logger);
    const resultado = await canal.enviar(
      notificacionBase({ destinatario: null }),
    );
    expect(resultado.ok).toBe(true);
    expect(espia.llamadas[0]!.obj.to).toBeNull();
  });
});

describe("EmailChannel — fallo grácil sin credenciales (RB-CMR-05)", () => {
  it("sin RESEND_API_KEY → ok:false con error_codigo config_ausente (no lanza)", async () => {
    const canal = new EmailChannel({});
    const resultado = await canal.enviar(notificacionBase());
    expect(resultado).toEqual({ ok: false, error_codigo: "config_ausente" });
  });

  it("con credenciales pero sin destinatario → error_codigo sin_destinatario", async () => {
    const canal = new EmailChannel({ apiKey: "re_123", from: "no-reply@demo.local" });
    const resultado = await canal.enviar(
      notificacionBase({ destinatario: null }),
    );
    expect(resultado).toEqual({ ok: false, error_codigo: "sin_destinatario" });
  });
});

describe("construirEmail — contenido RB-CMR-06 (sin datos de terceros)", () => {
  it("incluye cliente, servicio, fecha/hora local del negocio y enlace", () => {
    const { subject, text } = construirEmail(notificacionBase());

    expect(subject).toContain("Consulta general");
    expect(text).toContain("Laura Pérez");
    expect(text).toContain("Consulta general");
    // Hora local del negocio (AD-06): 13:00Z → 10:00 en Buenos Aires.
    expect(text).toContain("2026-10-15 10:00");
    expect(text).toContain("/g/token-de-prueba");
  });

  it("no filtra datos de terceros: el cuerpo no contiene direcciones de correo", () => {
    const { text } = construirEmail(notificacionBase());
    // El destinatario va en el campo `to`, nunca en el cuerpo (EC-05).
    expect(text).not.toMatch(/@/);
  });

  it("formatea la fecha en la zona del negocio, no en UTC", () => {
    const { text } = construirEmail(
      notificacionBase({ timezone: "Europe/Madrid" }),
    );
    // 13:00Z → 15:00 en Madrid (UTC+2 en octubre, DST).
    expect(text).toContain("2026-10-15 15:00");
  });
});

// --- Unidad: selección de canal (NotificationService) ---

describe("resolverCanal — selección por entorno y por recordatorio (diseño §6.1)", () => {
  it("NOTIFICATION_CHANNEL=log fuerza el canal log aunque el recordatorio sea email", () => {
    expect(resolverCanal(RecordatorioCanal.Log, RecordatorioCanal.Email)).toBe(
      RecordatorioCanal.Log,
    );
  });

  it("NOTIFICATION_CHANNEL=email respeta el canal del recordatorio", () => {
    expect(resolverCanal(RecordatorioCanal.Email, RecordatorioCanal.Email)).toBe(
      RecordatorioCanal.Email,
    );
    expect(resolverCanal(RecordatorioCanal.Email, RecordatorioCanal.Log)).toBe(
      RecordatorioCanal.Log,
    );
  });
});

describe("NotificationService — dispatch y propagación de fallo", () => {
  it("configCanal=log despacha por LogChannel aunque el recordatorio sea email", async () => {
    const email = canalEspia();
    const log = canalEspia();
    const servicio = new NotificationService({
      configCanal: RecordatorioCanal.Log,
      canales: { email: email.canal, log: log.canal },
    });

    const resultado = await servicio.enviar(notificacionBase());
    expect(resultado.ok).toBe(true);
    expect(email.llamadas).toHaveLength(0);
    expect(log.llamadas).toHaveLength(1);
  });

  it("configCanal=email usa EmailChannel para recordatorios con canal email", async () => {
    const email = canalEspia();
    const log = canalEspia();
    const servicio = new NotificationService({
      configCanal: RecordatorioCanal.Email,
      canales: { email: email.canal, log: log.canal },
    });

    await servicio.enviar(notificacionBase({ canal: RecordatorioCanal.Email }));
    expect(email.llamadas).toHaveLength(1);
    expect(log.llamadas).toHaveLength(0);
  });

  it("expone el fallo del canal para que el scheduler decida el reintento", async () => {
    const email = canalEspia({ ok: false, error_codigo: "smtp_500" });
    const servicio = new NotificationService({
      configCanal: RecordatorioCanal.Email,
      canales: { email: email.canal, log: canalEspia().canal },
    });

    const resultado = await servicio.enviar(
      notificacionBase({ canal: RecordatorioCanal.Email }),
    );
    expect(resultado).toEqual({ ok: false, error_codigo: "smtp_500" });
  });

  it("crearNotificationService: NOTIFICATION_CHANNEL=log no exige RESEND_API_KEY", async () => {
    const espia = loggerEspia();
    const servicio = crearNotificationService(
      { NOTIFICATION_CHANNEL: RecordatorioCanal.Log },
      espia.logger,
    );
    const resultado = await servicio.enviar(notificacionBase());
    expect(resultado.ok).toBe(true);
    expect(espia.llamadas).toHaveLength(1);
  });
});

// --- Unidad: backoff y elegibilidad (funciones puras del scheduler) ---

describe("backoff de reintentos (RB-CMR-05: 5/15/60 min, hasta 3)", () => {
  it("expone la política 5/15/60 con máximo 3 intentos", () => {
    expect(BACKOFF_MINUTOS).toEqual([5, 15, 60]);
    expect(MAX_INTENTOS).toBe(3);
  });

  it("siguienteProgramadoPara aplica el backoff según el número de intentos", () => {
    const ahora = new Date("2026-10-10T12:00:00.000Z");
    expect(siguienteProgramadoPara(1, ahora).toISOString()).toBe(
      "2026-10-10T12:05:00.000Z",
    );
    expect(siguienteProgramadoPara(2, ahora).toISOString()).toBe(
      "2026-10-10T12:15:00.000Z",
    );
    expect(siguienteProgramadoPara(3, ahora).toISOString()).toBe(
      "2026-10-10T13:00:00.000Z",
    );
  });
});

describe("turnoNoEnviable — turno inactivo o fecha pasada (RB-CMR-04, CMR-S7)", () => {
  const ahora = new Date("2026-10-10T12:00:00.000Z");
  const futuro = new Date("2026-10-10T13:00:00.000Z");
  const pasado = new Date("2026-10-10T11:00:00.000Z");

  it("pendiente/confirmado con fecha futura SÍ son enviables", () => {
    expect(turnoNoEnviable(TurnoEstado.Pendiente, futuro, ahora)).toBe(false);
    expect(turnoNoEnviable(TurnoEstado.Confirmado, futuro, ahora)).toBe(false);
  });

  it("estado no activo (cancelado/completado/no_show) NO es enviable (CMR-S6)", () => {
    expect(turnoNoEnviable(TurnoEstado.Cancelado, futuro, ahora)).toBe(true);
    expect(turnoNoEnviable(TurnoEstado.Completado, futuro, ahora)).toBe(true);
    expect(turnoNoEnviable(TurnoEstado.NoShow, futuro, ahora)).toBe(true);
  });

  it("fecha pasada NO es enviable aunque siga pendiente (CMR-S7)", () => {
    expect(turnoNoEnviable(TurnoEstado.Pendiente, pasado, ahora)).toBe(true);
  });
});

describe("CMR-S5 — lead corto: programación inmediata (coherente con T-10)", () => {
  it("calcularProgramadoPara devuelve `ahora` cuando el resto ≤ lead", () => {
    const ahora = new Date("2026-10-10T12:00:00.000Z");
    const inicio = new Date("2026-10-10T14:00:00.000Z"); // dentro de 2 h
    expect(calcularProgramadoPara(inicio, 1440, ahora).toISOString()).toBe(
      ahora.toISOString(),
    );
  });
});

// --- Unidad: arranque del scheduler (guard anti doble arranque) ---

describe("iniciarScheduler — guard contra doble arranque", () => {
  it("el segundo arranque es no-op y detenerScheduler libera el handle", () => {
    const dbFalso = {} as Database;
    const servicio = {} as NotificationService;

    const primero = iniciarScheduler(dbFalso, servicio, {
      leadMin: 1440,
      intervaloMs: 60_000,
    });
    const segundo = iniciarScheduler(dbFalso, servicio, {
      leadMin: 1440,
      intervaloMs: 60_000,
    });

    expect(primero).toBe(true);
    expect(segundo).toBe(false);

    detenerScheduler();
    // Tras detener, un nuevo arranque vuelve a tener éxito.
    expect(
      iniciarScheduler(dbFalso, servicio, { leadMin: 1440, intervaloMs: 60_000 }),
    ).toBe(true);
    detenerScheduler();
  });
});

// --- Integración (BD de test) ---

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

async function primerSlotLibre(
  app: FastifyInstance,
  servicioId: string,
  minAheadMs = 0,
): Promise<string> {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/agenda?servicio_id=${servicioId}&desde=${fechaISO(0)}&hasta=${fechaISO(7)}`,
  });
  expect(res.statusCode).toBe(200);
  const cuerpo = res.json() as {
    dias: Array<{ slots: Array<{ slot_key: string; fecha_hora_inicio: string }> }>;
  };
  const slots = cuerpo.dias
    .flatMap((d) => d.slots)
    .sort((a, b) => a.fecha_hora_inicio.localeCompare(b.fecha_hora_inicio));
  const slot = slots.find(
    (s) => new Date(s.fecha_hora_inicio).getTime() >= Date.now() + minAheadMs,
  );
  if (slot === undefined) throw new Error("sin slots libres en el rango");
  return slot.slot_key;
}

async function reservar(
  app: FastifyInstance,
  servicioId: string,
  cliente: Record<string, string>,
  minAheadMs = 0,
): Promise<{ turno_id: string; enlace_gestion: string }> {
  const slotKey = await primerSlotLibre(app, servicioId, minAheadMs);
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
  return res.json() as { turno_id: string; enlace_gestion: string };
}

async function recordatorioDe(db: Database, turnoId: string) {
  return db.query.recordatorios.findFirst({
    where: eq(recordatorios.turno_id, turnoId),
  });
}

async function eventosDe(
  db: Database,
  turnoId: string,
  tipo: EventoTipo,
): Promise<Array<{ payload: Record<string, unknown> }>> {
  const filas = await db
    .select({ payload: eventosMetricas.payload })
    .from(eventosMetricas)
    .where(
      and(
        eq(eventosMetricas.turno_id, turnoId),
        eq(eventosMetricas.tipo, tipo),
      ),
    );
  return filas.map((fila) => ({
    payload: fila.payload as Record<string, unknown>,
  }));
}

function servicioDePrueba(
  configCanal: RecordatorioCanal,
  espia?: CanalEspia,
  resultado?: ResultadoEnvio,
): { servicio: NotificationService; espia: CanalEspia } {
  const canal = espia ?? canalEspia(resultado);
  const servicio = new NotificationService({
    configCanal,
    canales: { email: canal.canal, log: canal.canal },
  });
  return { servicio, espia: canal };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "ReminderScheduler.sweep — recordatorios (T-12)",
  () => {
    it("CMR-S6: turno cancelado → recordatorio cancelado, sin envío ni evento", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const creada = await reservar(app, servicio.id, {
        nombre: "Ana Gil",
        email: "ana@example.com",
      });

      await db
        .update(recordatorios)
        .set({ programado_para: new Date(Date.now() - 60_000) })
        .where(eq(recordatorios.turno_id, creada.turno_id));
      // El negocio cancela el turno (T-14 aún no implementado → simulado).
      await db
        .update(turnos)
        .set({ estado: TurnoEstado.Cancelado, updated_at: new Date() })
        .where(eq(turnos.id, creada.turno_id));

      const { servicio: notif, espia } = servicioDePrueba(
        RecordatorioCanal.Log,
      );
      const resumen = await sweep(db, notif, { leadMin: 1440 });

      const fila = await recordatorioDe(db, creada.turno_id);
      expect(fila?.estado).toBe(RecordatorioEstado.Cancelado);
      expect(espia.llamadas).toHaveLength(0);
      expect(resumen.cancelados).toBe(1);
      expect(resumen.enviados).toBe(0);
      expect(await eventosDe(db, creada.turno_id, EventoTipo.RecordatorioEnviado)).toHaveLength(0);

      await app.close();
    });

    it("CMR-S7: turno pendiente con fecha pasada → recordatorio cancelado; el turno sigue pendiente", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const creada = await reservar(app, servicio.id, {
        nombre: "Beto Ruiz",
        email: "beto@example.com",
      });

      // Fecha del turno en el pasado (sin resolver por el negocio).
      const hace2Horas = new Date(Date.now() - 2 * 3_600_000);
      await db
        .update(turnos)
        .set({
          fecha_hora_inicio: hace2Horas,
          fecha_hora_fin: new Date(hace2Horas.getTime() + 30 * 60_000),
          updated_at: new Date(),
        })
        .where(eq(turnos.id, creada.turno_id));
      await db
        .update(recordatorios)
        .set({ programado_para: new Date(Date.now() - 60_000) })
        .where(eq(recordatorios.turno_id, creada.turno_id));

      const { servicio: notif, espia } = servicioDePrueba(
        RecordatorioCanal.Log,
      );
      const resumen = await sweep(db, notif, { leadMin: 1440 });

      const fila = await recordatorioDe(db, creada.turno_id);
      expect(fila?.estado).toBe(RecordatorioEstado.Cancelado);
      expect(espia.llamadas).toHaveLength(0);
      expect(resumen.cancelados).toBe(1);

      const turno = await db.query.turnos.findFirst({
        where: eq(turnos.id, creada.turno_id),
      });
      expect(turno?.estado).toBe(TurnoEstado.Pendiente);

      await app.close();
    });

    it("happy path: turno activo futuro → enviado + evento recordatorio_enviado correlacionado por turno_id (CA-CMR-05)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const creada = await reservar(app, servicio.id, {
        nombre: "Cami Soto",
        email: "cami@example.com",
      });

      await db
        .update(recordatorios)
        .set({ programado_para: new Date(Date.now() - 60_000) })
        .where(eq(recordatorios.turno_id, creada.turno_id));

      const espia = loggerEspia();
      const notif = crearNotificationService(
        { NOTIFICATION_CHANNEL: RecordatorioCanal.Log },
        espia.logger,
      );
      const resumen = await sweep(db, notif, { leadMin: 1440 });

      const fila = await recordatorioDe(db, creada.turno_id);
      expect(fila?.estado).toBe(RecordatorioEstado.Enviado);
      expect(fila?.enviado_en).not.toBeNull();
      expect(fila?.intentos).toBe(0);
      expect(resumen.enviados).toBe(1);

      // CA-CMR-05: evento correlacionado por turno_id con payload §13.
      const eventos = await eventosDe(
        db,
        creada.turno_id,
        EventoTipo.RecordatorioEnviado,
      );
      expect(eventos).toHaveLength(1);
      // `canal` del evento = canal programado del recordatorio (§13); el
      // envío efectivo pasó por LogChannel por NOTIFICATION_CHANNEL=log.
      expect(eventos[0]!.payload).toEqual({
        canal: RecordatorioCanal.Email,
        lead_min: 1440,
        intento: 1,
      });

      // RB-CMR-06: el cuerpo del email no incluye datos de terceros (p. ej.
      // el contacto del negocio que vive en `tenants`).
      const cuerpo = String(espia.llamadas[0]!.obj.body);
      expect(cuerpo).toContain("Cami Soto");
      expect(cuerpo).not.toContain("contacto@demo.local");
      expect(cuerpo).not.toContain("+54 11 5555-0100");

      await app.close();
    });

    it("CMR-S4/CA-CMR-03: proveedor caído → reintentos 5/15/60 y fallido con intentos<=3 + 1 evento recordatorio_fallido", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      // Slot ≥ 25 h en el futuro: el turno permanece "enviable" durante todo
      // el backoff (5/15/60 min) sin cruzar el inicio del turno, de modo que
      // el resultado no depende de la hora del día en que se corra el test.
      const creada = await reservar(
        app,
        servicio.id,
        {
          nombre: "Dani Vera",
          email: "dani@example.com",
        },
        25 * 3_600_000,
      );

      await db
        .update(recordatorios)
        .set({ programado_para: new Date(Date.now() - 60_000) })
        .where(eq(recordatorios.turno_id, creada.turno_id));

      const { servicio: notif, espia } = servicioDePrueba(
        RecordatorioCanal.Email,
        undefined,
        { ok: false, error_codigo: "smtp_500" },
      );

      // 1 intento inicial + 3 reintentos (backoff 5/15/60) = 4 corridas.
      let ahora = new Date();
      for (let i = 0; i < 4; i += 1) {
        await sweep(db, notif, { leadMin: 1440, ahora });
        const fila = await recordatorioDe(db, creada.turno_id);
        if (fila !== undefined) {
          ahora = new Date(fila.programado_para.getTime() + 1_000);
        }
      }

      expect(espia.llamadas).toHaveLength(4);

      const fila = await recordatorioDe(db, creada.turno_id);
      expect(fila?.estado).toBe(RecordatorioEstado.Fallido);
      // CA-CMR-03: resuelto con intentos <= 3.
      expect(fila?.intentos).toBe(MAX_INTENTOS);
      expect(fila?.intentos).toBeLessThanOrEqual(MAX_INTENTOS);
      expect(fila?.ultimo_error).toBe("smtp_500");

      const eventos = await eventosDe(
        db,
        creada.turno_id,
        EventoTipo.RecordatorioFallido,
      );
      expect(eventos).toHaveLength(1);
      expect(eventos[0]!.payload).toEqual({
        canal: RecordatorioCanal.Email,
        intento: 4,
        error_codigo: "smtp_500",
      });

      await app.close();
    });

    it("CMR-S5: recordatorio programado para 'ahora' (resto <= lead) se envía en la primera corrida", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const creada = await reservar(app, servicio.id, {
        nombre: "Ema Luna",
        email: "ema@example.com",
      });

      // T-10 ya programa `ahora` cuando el resto <= lead; simulamos ese caso.
      await db
        .update(recordatorios)
        .set({ programado_para: new Date() })
        .where(eq(recordatorios.turno_id, creada.turno_id));

      const { servicio: notif, espia } = servicioDePrueba(
        RecordatorioCanal.Log,
      );
      const resumen = await sweep(db, notif, { leadMin: 1440 });

      expect(resumen.enviados).toBe(1);
      expect(espia.llamadas).toHaveLength(1);
      const fila = await recordatorioDe(db, creada.turno_id);
      expect(fila?.estado).toBe(RecordatorioEstado.Enviado);

      await app.close();
    });

    it("no procesa recordatorios cuyo programado_para es futuro (cola ordenada por vencimiento)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);
      const servicio = await primerServicio(app);
      const creada = await reservar(app, servicio.id, {
        nombre: "Fito Mar",
        email: "fito@example.com",
      });

      await db
        .update(recordatorios)
        .set({ programado_para: new Date(Date.now() + 3_600_000) })
        .where(eq(recordatorios.turno_id, creada.turno_id));

      const { servicio: notif, espia } = servicioDePrueba(
        RecordatorioCanal.Log,
      );
      const resumen = await sweep(db, notif, { leadMin: 1440 });

      expect(resumen.procesados).toBe(0);
      expect(espia.llamadas).toHaveLength(0);
      const fila = await recordatorioDe(db, creada.turno_id);
      expect(fila?.estado).toBe(RecordatorioEstado.Programado);

      await app.close();
    });
  },
);
