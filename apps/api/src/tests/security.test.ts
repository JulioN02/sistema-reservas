import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";
import { createDb, type Database } from "../db";
import { seedDatabase } from "../db/seed";
import { PROBLEM_BASE_URI } from "../infra/errors";
import { MUTACION_MAX } from "../infra/security";

/**
 * Security pass (T-18, diseño §8) — controles a nivel de app:
 *
 * - Helmet: CSP + X-Content-Type-Options nosniff.
 * - CORS: origen específico (`CORS_ORIGIN`), credenciales, nunca `*`.
 * - Rate limit GENERAL de mutaciones por IP (429 problem+json); el login
 *   conserva su límite propio de 5/15 min (verificado en auth.test.ts).
 * - CSRF: guard de content-type (JSON obligatorio) + SameSite=Lax (T-07).
 *
 * Los controles corren antes de tocar la BD (plugins/onRequest/preHandler),
 * por lo que la mayoría de las pruebas usan una app sin base de datos.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/sistema_reservas_test";

const CORS_ORIGIN = "http://localhost:5173";
const OPERADOR_EMAIL = "operador@demo.local";
const OPERADOR_PASSWORD = "demo-password-123";

/** Ruta absoluta a apps/api/drizzle, independiente del cwd (F-02). */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

function crearEnv(extra?: Record<string, string>) {
  return parseEnv({ DATABASE_URL: TEST_DATABASE_URL, ...extra });
}

/** App liviana: los plugins y guards corren antes de cualquier query. */
async function crearApp(extra?: Record<string, string>): Promise<FastifyInstance> {
  return buildApp({
    env: crearEnv(extra),
    loggerOptions: { level: "silent" },
    checkDb: async () => true,
  });
}

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

describe("security — plugins y guards (T-18)", () => {
  it("helmet: toda respuesta lleva X-Content-Type-Options nosniff y CSP", async () => {
    const app = await crearApp();

    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");

    const csp = res.headers["content-security-policy"];
    expect(csp, "debe haber Content-Security-Policy").toBeDefined();
    // CSP estricta y sensata para una API JSON consumida por una SPA.
    expect(String(csp)).toContain("default-src 'none'");
    expect(String(csp)).toContain("frame-ancestors 'none'");

    await app.close();
  });

  it("CORS: permite el origen específico con credenciales (nunca `*`)", async () => {
    const app = await crearApp();

    const permitido = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { origin: CORS_ORIGIN },
    });
    expect(permitido.headers["access-control-allow-origin"]).toBe(CORS_ORIGIN);
    expect(permitido.headers["access-control-allow-credentials"]).toBe("true");

    // Origen ajeno: la API NUNCA responde con wildcard; solo refleja el origen
    // configurado (que el navegador rechaza al no coincidir con el solicitado).
    const ajeno = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { origin: "http://malicioso.example" },
    });
    expect(ajeno.headers["access-control-allow-origin"]).not.toBe("*");
    expect(ajeno.headers["access-control-allow-origin"]).toBe(CORS_ORIGIN);

    await app.close();
  });

  it("CSRF: mutación con content-type no JSON → 400 problem+json", async () => {
    const app = await crearApp();

    // `text/plain` es un content type *safelisted* por CORS: es exactamente el
    // que usaría un formulario/ataque cross-site. El guard lo rechaza.
    const noJson = await app.inject({
      method: "POST",
      url: "/api/v1/turnos",
      headers: { "content-type": "text/plain" },
      payload: "consentimiento=true",
    });
    expect(noJson.statusCode).toBe(400);
    expect(noJson.headers["content-type"]).toContain("application/problem+json");
    expect(noJson.json().type).toBe(`${PROBLEM_BASE_URI}/solicitud-invalida`);

    // Triangulación: un content type sin parser registrado → 415, también
    // problem+json (honra el statusCode de Fastify, W1).
    const sinParser = await app.inject({
      method: "POST",
      url: "/api/v1/turnos",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "a=1",
    });
    expect(sinParser.statusCode).toBe(415);
    expect(sinParser.headers["content-type"]).toContain("application/problem+json");

    await app.close();
  });

  it("rate limit general: supera el máximo de mutaciones por IP → 429 problem+json", async () => {
    const app = await crearApp();

    // Cada POST /turnos inválido corta en el DTO (422) SIN tocar la BD, pero
    // consume cupo del límite general de mutaciones.
    for (let i = 0; i < MUTACION_MAX; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/turnos",
        payload: {},
      });
      expect(res.statusCode).toBe(422);
    }

    const bloqueado = await app.inject({
      method: "POST",
      url: "/api/v1/turnos",
      payload: {},
    });
    expect(bloqueado.statusCode).toBe(429);
    expect(bloqueado.headers["content-type"]).toContain("application/problem+json");
    expect(bloqueado.json().type).toBe(`${PROBLEM_BASE_URI}/demasiadas-peticiones`);

    await app.close();
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "security — flags de cookie (T-18, RB-VNG-05)",
  () => {
    async function crearAppConBd(db: Database, extra?: Record<string, string>) {
      return buildApp({
        env: crearEnv(extra),
        db,
        loggerOptions: { level: "silent" },
      });
    }

    async function login(app: FastifyInstance) {
      return app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: OPERADOR_EMAIL, password: OPERADOR_PASSWORD },
      });
    }

    it("la cookie de sesión es httpOnly + SameSite=Lax (sin Secure en dev)", async () => {
      const db = await prepararBd();
      const app = await crearAppConBd(db);

      const res = await login(app);
      expect(res.statusCode).toBe(200);
      const setCookie = res.headers["set-cookie"] as string[];
      const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookie ?? "").toContain("sid=");
      expect(cookie ?? "").toContain("HttpOnly");
      expect(cookie ?? "").toContain("SameSite=Lax");
      expect(cookie ?? "").not.toContain("Secure");

      await app.close();
    });

    it("con COOKIE_SECURE=true la cookie suma Secure (producción)", async () => {
      const db = await prepararBd();
      const app = await crearAppConBd(db, { COOKIE_SECURE: "true" });

      const res = await login(app);
      const setCookie = res.headers["set-cookie"] as string[];
      const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookie ?? "").toContain("Secure");

      await app.close();
    });
  },
);
