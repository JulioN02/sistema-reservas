import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import type { LightMyRequestResponse } from "fastify";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";
import { createDb, type Database } from "../db";
import { seedDatabase } from "../db/seed";

/**
 * Conformancia de contrato (T-21, INT-05) — camina `packages/contracts/openapi.yaml`
 * y lo confronta con las rutas REALMENTE registradas en Fastify:
 *
 * 1. Inventario del contrato: cada path + método documentado.
 * 2. Registro: cada operación del contrato tiene una ruta registrada
 *    (0 faltantes). `/turnos/{token}` y `/turnos/{id}` son alias de la única
 *    ruta real `/turnos/:param` (Fastify no admite dos rutas con el mismo
 *    patrón — T-15), así que se expanden los alias del árbol de rutas.
 * 3. Códigos: requests representativos producen un código DOCUMENTADO para su
 *    operación (muestreo). Un código observado no documentado es una deriva
 *    YAML↔zod (R-D8) → CRITICAL.
 * 4. Esquemas: validación manual selectiva de las respuestas contra los
 *    esquemas del YAML (componentes usados por los endpoints muestreados).
 *
 * Reportar paths sin ruta registrada = 0 (CRITICAL si no).
 *
 * Requiere PostgreSQL de test (TEST_DATABASE_URL; override local 5437).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5437/sistema_reservas_test";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));
const OPENAPI_PATH = fileURLToPath(
  new URL("../../../../packages/contracts/openapi.yaml", import.meta.url),
);

/** Base de servidor declarada en el contrato (`servers[0].url`). */
const BASE_API = "/api/v1";

const METODOS = ["get", "post", "put", "patch", "delete"] as const;
type Metodo = (typeof METODOS)[number];

const OPERADOR_EMAIL = "operador@demo.local";
const OPERADOR_PASSWORD = "demo-password-123";

// --- Inventario del contrato ---

interface OperacionContrato {
  /** Path del YAML, p. ej. `/turnos/{token}`. */
  path: string;
  method: Metodo;
  /** Códigos de respuesta documentados, p. ej. ["200","404"]. */
  codigos: string[];
}

/** Lee y parsea el YAML del contrato y extrae path + método + códigos. */
function inventarioContrato(): OperacionContrato[] {
  const doc = parseYaml(readFileSync(OPENAPI_PATH, "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const operaciones: OperacionContrato[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METODOS) {
      const op = item[method];
      if (op === undefined) continue;
      const responses =
        (op as { responses?: Record<string, unknown> }).responses ?? {};
      operaciones.push({ path, method, codigos: Object.keys(responses) });
    }
  }
  return operaciones;
}

/** Convierte un path del YAML a la forma Fastify: `{param}` → `:param`. */
function aRutaFastify(path: string): string {
  return `${BASE_API}${path.replace(/\{([^}]+)\}/g, ":$1")}`;
}

/**
 * Normaliza los nombres de parámetro a `:p`. Fastify agrupa `/turnos/{token}`
 * y `/turnos/{id}` en UN nodo `/:param|:token|:id` (misma ruta real — T-15),
 * así que la comparación contrato↔rutas debe ignorar el nombre del parámetro.
 */
function canonicalizar(ruta: string): string {
  return ruta
    .split("/")
    .map((seg) => (seg.startsWith(":") ? ":p" : seg))
    .join("/");
}

/** Clave canónica `"<method> <path canónico>"` de una operación del contrato. */
function claveContrato(path: string, method: Metodo): string {
  return `${method} ${canonicalizar(aRutaFastify(path))}`;
}

/**
 * Rutas registradas en Fastify, leídas del árbol de `printRoutes` (API de
 * introspección documentada). Devuelve claves canónicas `"<method> <path>"`.
 */
function rutasRegistradas(app: FastifyInstance): Set<string> {
  const arbol = app.printRoutes({ commonPrefix: false });
  const rutas = new Set<string>();
  const stack: string[] = [];
  for (const raw of arbol.split("\n")) {
    const linea = raw.replace(/\s+$/, "");
    if (linea === "") continue;
    // Cada nivel aporta 4 caracteres de prefijo (`│   ` o `    `) + conector.
    const match = /^((?:│ {3}| {4})*)(?:├── |└── )?(.*)$/.exec(linea);
    if (match === null) continue;
    const depth = match[1]!.length / 4;
    const contenido = match[2]!;
    const m2 = /^(\S+)(?: \(([^)]+)\))?$/.exec(contenido);
    if (m2 === null) continue;
    const segmento = m2[1]!;
    if (segmento === "*") continue; // wildcard OPTIONS
    const metodos = (m2[2] ?? "")
      .split(", ")
      .map((m) => m.toLowerCase())
      .filter((m): m is Metodo => (METODOS as readonly string[]).includes(m));
    const base = stack.slice(0, depth).join("");
    const ruta = canonicalizar(`${base}${segmento}`);
    for (const method of metodos) {
      rutas.add(`${method} ${ruta}`);
    }
    stack[depth] = segmento;
  }
  return rutas;
}

// --- Helpers de BD / app ---

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

/** Extrae el token `sid` de la cookie seteada por el servidor. */
function sidToken(setCookie: string[] | string | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = /(?:^|;\s*)sid=([^;]+)/.exec(raw ?? "");
  return match?.[1] ?? "";
}

// --- Validación manual de esquemas (subconjunto del YAML) ---

function esUuid(valor: unknown): boolean {
  return typeof valor === "string" && /^[0-9a-f-]{36}$/.test(valor);
}

function esIso8601(valor: unknown): boolean {
  return (
    typeof valor === "string" &&
    !Number.isNaN(Date.parse(valor)) &&
    /^\d{4}-\d{2}-\d{2}T/.test(valor)
  );
}

/** Valida una respuesta problem+json contra el esquema `Error`. */
function validarProblemJson(cuerpo: unknown, codigo: number): void {
  expect(cuerpo, "problem+json debe ser un objeto").toBeTypeOf("object");
  const err = cuerpo as Record<string, unknown>;
  expect(typeof err.type).toBe("string");
  expect(typeof err.title).toBe("string");
  expect(err.status).toBe(codigo);
  expect(typeof err.detail).toBe("string");
}

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "conformancia de contrato — OpenAPI ↔ Fastify (T-21)",
  () => {
    it("cada path+método del contrato tiene una ruta registrada (0 faltantes) y no hay rutas no documentadas", async () => {
      const app = await crearApp(await prepararBd());
      const registradas = rutasRegistradas(app);
      expect(registradas.size, "el parser de rutas no encontró nada").toBeGreaterThan(
        0,
      );

      const contrato = inventarioContrato();
      expect(contrato.length).toBeGreaterThan(0);

      // (1) contrato ⊆ rutas registradas — 0 faltantes (CRITICAL si no).
      const faltantes: string[] = [];
      for (const op of contrato) {
        const clave = claveContrato(op.path, op.method);
        if (!registradas.has(clave)) faltantes.push(clave);
      }
      expect(
        faltantes,
        "CRITICAL: paths/métodos del contrato sin ruta registrada",
      ).toEqual([]);

      // (2) rutas registradas ⊆ contrato — sin rutas huérfanas no documentadas.
      const documentadas = new Set(
        contrato.map((op) => claveContrato(op.path, op.method)),
      );
      const extras = [...registradas].filter((r) => !documentadas.has(r));
      expect(
        extras,
        "rutas registradas que el contrato no documenta (deriva)",
      ).toEqual([]);

      await app.close();
    });

    it("requests representativos producen códigos DOCUMENTADOS para su operación (sin deriva YAML↔zod)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);

      // Datos de apoyo: un servicio y un slot válidos del seed.
      const servicios = await app.inject({
        method: "GET",
        url: "/api/v1/servicios",
      });
      const servicio = (
        servicios.json() as Array<{ id: string; duracion_min: number }>
      ).find((s) => s.duracion_min === 30);
      if (servicio === undefined) throw new Error("sin servicio de 30 min");
      const agenda = await app.inject({
        method: "GET",
        url: `/api/v1/agenda?servicio_id=${servicio.id}&desde=${fechaISO(0)}&hasta=${fechaISO(7)}`,
      });
      const slotKey = (
        agenda.json() as {
          dias: Array<{ slots: Array<{ slot_key: string }> }>;
        }
      ).dias.flatMap((d) => d.slots)[0]!.slot_key;
      const turnoValido = {
        servicio_id: servicio.id,
        slot_key: slotKey,
        cliente: { nombre: "Conformidad", email: "conformidad@example.com" },
        consentimiento: true,
      };

      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: OPERADOR_EMAIL, password: OPERADOR_PASSWORD },
      });
      const cookie = sidToken(login.headers["set-cookie"]);
      const tokenInvalido = "A".repeat(43);
      const uuidAleatorio = "11111111-1111-1111-1111-111111111111";

      const muestras: Array<{
        path: string;
        method: Metodo;
        descripcion: string;
        request: () => Promise<LightMyRequestResponse>;
      }> = [
        {
          path: "/health",
          method: "get",
          descripcion: "GET /health → 200",
          request: () => app.inject({ method: "GET", url: "/api/v1/health" }),
        },
        {
          path: "/servicios",
          method: "get",
          descripcion: "GET /servicios → 200",
          request: () =>
            app.inject({ method: "GET", url: "/api/v1/servicios" }),
        },
        {
          path: "/agenda",
          method: "get",
          descripcion: "GET /agenda válido → 200",
          request: () =>
            app.inject({
              method: "GET",
              url: `/api/v1/agenda?servicio_id=${servicio.id}&desde=${fechaISO(0)}&hasta=${fechaISO(1)}`,
            }),
        },
        {
          path: "/agenda",
          method: "get",
          descripcion: "GET /agenda malformado → 400",
          request: () =>
            app.inject({
              method: "GET",
              url: "/api/v1/agenda?servicio_id=no-uuid&desde=abc&hasta=xyz",
            }),
        },
        {
          path: "/agenda",
          method: "get",
          descripcion: "GET /agenda servicio desconocido → 404",
          request: () =>
            app.inject({
              method: "GET",
              url: `/api/v1/agenda?servicio_id=${uuidAleatorio}&desde=${fechaISO(0)}&hasta=${fechaISO(1)}`,
            }),
        },
        {
          path: "/turnos",
          method: "post",
          descripcion: "POST /turnos válido → 201",
          request: () =>
            app.inject({
              method: "POST",
              url: "/api/v1/turnos",
              payload: turnoValido,
            }),
        },
        {
          path: "/turnos",
          method: "post",
          descripcion: "POST /turnos sin canal → 422",
          request: () =>
            app.inject({
              method: "POST",
              url: "/api/v1/turnos",
              payload: {
                ...turnoValido,
                cliente: { nombre: "Sin canal" },
              },
            }),
        },
        {
          path: "/turnos",
          method: "post",
          descripcion: "POST /turnos slot ocupado → 409",
          request: () =>
            app.inject({
              method: "POST",
              url: "/api/v1/turnos",
              payload: {
                ...turnoValido,
                cliente: { nombre: "Otro", email: "otro@example.com" },
              },
            }),
        },
        {
          path: "/turnos",
          method: "get",
          descripcion: "GET /turnos sin sesión → 401",
          request: () => app.inject({ method: "GET", url: "/api/v1/turnos" }),
        },
        {
          path: "/turnos/{token}",
          method: "get",
          descripcion: "GET /turnos/{token} inválido → 404",
          request: () =>
            app.inject({
              method: "GET",
              url: `/api/v1/turnos/${tokenInvalido}`,
            }),
        },
        {
          path: "/turnos/{token}/confirmar",
          method: "post",
          descripcion: "POST /turnos/{token}/confirmar inválido → 404",
          request: () =>
            app.inject({
              method: "POST",
              url: `/api/v1/turnos/${tokenInvalido}/confirmar`,
            }),
        },
        {
          path: "/turnos/{id}/acciones",
          method: "post",
          descripcion: "POST /turnos/{id}/acciones sin sesión → 401",
          request: () =>
            app.inject({
              method: "POST",
              url: `/api/v1/turnos/${uuidAleatorio}/acciones`,
              payload: { accion: "confirmar" },
            }),
        },
        {
          path: "/auth/login",
          method: "post",
          descripcion: "POST /auth/login válido → 200",
          request: () =>
            app.inject({
              method: "POST",
              url: "/api/v1/auth/login",
              payload: { email: OPERADOR_EMAIL, password: OPERADOR_PASSWORD },
            }),
        },
        {
          path: "/auth/login",
          method: "post",
          descripcion: "POST /auth/login credenciales inválidas → 401",
          request: () =>
            app.inject({
              method: "POST",
              url: "/api/v1/auth/login",
              payload: { email: OPERADOR_EMAIL, password: "incorrecta-123" },
            }),
        },
        {
          path: "/auth/logout",
          method: "post",
          descripcion: "POST /auth/logout sin sesión → 401",
          request: () =>
            app.inject({ method: "POST", url: "/api/v1/auth/logout" }),
        },
        {
          path: "/auth/me",
          method: "get",
          descripcion: "GET /auth/me sin sesión → 401",
          request: () => app.inject({ method: "GET", url: "/api/v1/auth/me" }),
        },
        {
          path: "/agenda/horarios",
          method: "get",
          descripcion: "GET /agenda/horarios sin sesión → 401",
          request: () =>
            app.inject({ method: "GET", url: "/api/v1/agenda/horarios" }),
        },
        {
          path: "/agenda/bloques",
          method: "get",
          descripcion: "GET /agenda/bloques sin sesión → 401",
          request: () =>
            app.inject({ method: "GET", url: "/api/v1/agenda/bloques" }),
        },
        {
          path: "/agenda/dia",
          method: "get",
          descripcion: "GET /agenda/dia sin sesión → 401",
          request: () =>
            app.inject({
              method: "GET",
              url: `/api/v1/agenda/dia?fecha=${fechaISO(0)}`,
            }),
        },
        {
          path: "/servicios/{id}/parametros",
          method: "patch",
          descripcion: "PATCH /servicios/{id}/parametros sin sesión → 401",
          request: () =>
            app.inject({
              method: "PATCH",
              url: `/api/v1/servicios/${servicio.id}/parametros`,
              payload: { booking_window_days: 15 },
            }),
        },
        {
          path: "/metricas/resumen",
          method: "get",
          descripcion: "GET /metricas/resumen sin sesión → 401",
          request: () =>
            app.inject({ method: "GET", url: "/api/v1/metricas/resumen" }),
        },
        {
          path: "/metricas/resumen",
          method: "get",
          descripcion: "GET /metricas/resumen con sesión → 200",
          request: () =>
            app.inject({
              method: "GET",
              url: "/api/v1/metricas/resumen",
              headers: { cookie: `sid=${cookie}` },
            }),
        },
      ];

      const contrato = inventarioContrato();
      const documentados = new Map(
        contrato.map((op) => [claveContrato(op.path, op.method), new Set(op.codigos)]),
      );

      const derivas: string[] = [];
      for (const muestra of muestras) {
        const res = await muestra.request();
        const clave = claveContrato(muestra.path, muestra.method);
        const codigos = documentados.get(clave);
        expect(codigos, `operación no documentada: ${clave}`).toBeDefined();
        if (!codigos!.has(String(res.statusCode))) {
          derivas.push(
            `${muestra.descripcion}: observado ${res.statusCode}, documentado [${[
              ...codigos!,
            ].join(", ")}]`,
          );
        }
      }
      expect(derivas, "deriva YAML↔zod (códigos no documentados)").toEqual([]);

      await app.close();
    }, 60_000);

    it("respuestas muestreadas validan contra los esquemas del YAML (validación manual selectiva)", async () => {
      const db = await prepararBd();
      const app = await crearApp(db);

      // Health: {status: "ok", db: "up"|"down"}.
      const health = await app.inject({ method: "GET", url: "/api/v1/health" });
      expect(health.statusCode).toBe(200);
      const healthCuerpo = health.json() as { status: string; db: string };
      expect(healthCuerpo.status).toBe("ok");
      expect(["up", "down"]).toContain(healthCuerpo.db);

      // ServicioPublico[]: required [id, nombre, duracion_min, precio, zona_horaria].
      const servicios = await app.inject({
        method: "GET",
        url: "/api/v1/servicios",
      });
      const lista = servicios.json() as Array<Record<string, unknown>>;
      expect(lista.length).toBeGreaterThan(0);
      for (const s of lista) {
        expect(esUuid(s.id)).toBe(true);
        expect(typeof s.nombre).toBe("string");
        expect(Number.isInteger(s.duracion_min)).toBe(true);
        expect((s.duracion_min as number) % 15).toBe(0);
        expect(s.precio === null || typeof s.precio === "number").toBe(true);
        expect(typeof s.zona_horaria).toBe("string");
      }

      // AgendaResponse: {zona_horaria, dias:[{fecha, slots:[{slot_key, inicio, fin}]}]}.
      const servicio = lista.find((s) => s.duracion_min === 30)!;
      const agenda = await app.inject({
        method: "GET",
        url: `/api/v1/agenda?servicio_id=${servicio.id}&desde=${fechaISO(0)}&hasta=${fechaISO(7)}`,
      });
      expect(agenda.statusCode).toBe(200);
      const agendaCuerpo = agenda.json() as {
        zona_horaria: string;
        dias: Array<{
          fecha: string;
          slots: Array<{
            slot_key: string;
            fecha_hora_inicio: string;
            fecha_hora_fin: string;
          }>;
        }>;
      };
      expect(typeof agendaCuerpo.zona_horaria).toBe("string");
      expect(agendaCuerpo.dias.length).toBeGreaterThan(0);
      const slots = agendaCuerpo.dias.flatMap((d) => d.slots);
      expect(slots.length).toBeGreaterThan(0);
      for (const slot of slots) {
        expect(typeof slot.slot_key).toBe("string");
        expect(slot.slot_key).toBe(
          `${slot.fecha_hora_inicio}|${servicio.id as string}`,
        );
        expect(esIso8601(slot.fecha_hora_inicio)).toBe(true);
        expect(esIso8601(slot.fecha_hora_fin)).toBe(true);
      }

      // TurnoCreado: required [turno_id, estado, enlace_gestion, cliente_id].
      const creado = await app.inject({
        method: "POST",
        url: "/api/v1/turnos",
        payload: {
          servicio_id: servicio.id,
          slot_key: slots[0]!.slot_key,
          cliente: { nombre: "Esquema", email: "esquema@example.com" },
          consentimiento: true,
        },
      });
      expect(creado.statusCode).toBe(201);
      const turnoCuerpo = creado.json() as Record<string, unknown>;
      expect(esUuid(turnoCuerpo.turno_id)).toBe(true);
      expect(turnoCuerpo.estado).toBe("pendiente");
      expect(typeof turnoCuerpo.enlace_gestion).toBe("string");
      expect(esUuid(turnoCuerpo.cliente_id)).toBe(true);

      // TurnoGestion vía el enlace de gestión: required [estado, servicio,
      // servicio_id, zona_horaria, fecha_hora_inicio, fecha_hora_fin, cliente_nombre].
      const token = (turnoCuerpo.enlace_gestion as string).replace(/^\/g\//, "");
      const gestion = await app.inject({
        method: "GET",
        url: `/api/v1/turnos/${token}`,
      });
      expect(gestion.statusCode).toBe(200);
      const gestionCuerpo = gestion.json() as Record<string, unknown>;
      expect(typeof gestionCuerpo.estado).toBe("string");
      expect(typeof gestionCuerpo.servicio).toBe("string");
      expect(esUuid(gestionCuerpo.servicio_id)).toBe(true);
      expect(typeof gestionCuerpo.zona_horaria).toBe("string");
      expect(esIso8601(gestionCuerpo.fecha_hora_inicio)).toBe(true);
      expect(esIso8601(gestionCuerpo.fecha_hora_fin)).toBe(true);
      expect(typeof gestionCuerpo.cliente_nombre).toBe("string");
      expect(gestionCuerpo).not.toHaveProperty("tenant_id");

      // Error (problem+json): required [type, title, status, detail].
      const error404 = await app.inject({
        method: "GET",
        url: "/api/v1/turnos/token-inexistente",
      });
      expect(error404.statusCode).toBe(404);
      expect(error404.headers["content-type"]).toContain(
        "application/problem+json",
      );
      validarProblemJson(error404.json(), 404);

      const error422 = await app.inject({
        method: "POST",
        url: "/api/v1/turnos",
        payload: {
          servicio_id: servicio.id,
          slot_key: slots[0]!.slot_key,
          cliente: { nombre: "Sin canal" },
          consentimiento: true,
        },
      });
      expect(error422.statusCode).toBe(422);
      validarProblemJson(error422.json(), 422);

      await app.close();
    }, 60_000);
  },
);
