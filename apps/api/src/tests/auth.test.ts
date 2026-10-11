import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";
import { createDb, type Database } from "../db";
import { seedDatabase } from "../db/seed";
import { operadores, sesiones } from "../db/schema";
import { createErrorHandler, PROBLEM_BASE_URI } from "../infra/errors";
import {
  crearRequireSession,
  SESION_COOKIE,
} from "../infra/authMiddleware";
import { hashToken } from "../services/authService";

/**
 * Módulo auth (T-07) — login/logout/me + sesiones opacas (capability
 * vista-negocio, RB-VNG-05).
 *
 * Escenarios GWT de la spec:
 * - VNG-S1: login ok → 200 + cookie de sesión; acceso autorizado a /auth/me.
 * - VNG-S2/CA-VNG-03: 5 fallos de login → 429 y bloqueo de 15 min; la sesión
 *   caduca a los 7 días (TTL).
 * - RB-VNG-05: cookie httpOnly + SameSite=Lax + Secure(prod); logout revoca.
 * - VNG-S7: sin cookie → 401 (también válido para rutas de negocio futuras).
 *
 * Requiere PostgreSQL de test (TEST_DATABASE_URL; default db-test:5433).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/sistema_reservas_test";

const OPERADOR_EMAIL = "operador@demo.local";
const OPERADOR_PASSWORD = "demo-password-123";
const SEGUNDOS_POR_DIA = 24 * 60 * 60;
const TTL_SESION_MS = 7 * SEGUNDOS_POR_DIA * 1000;

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

function crearEnv(extra?: Record<string, string>) {
  return parseEnv({ DATABASE_URL: TEST_DATABASE_URL, ...extra });
}

async function crearApp(
  db: Database,
  extra?: Record<string, string>,
): Promise<FastifyInstance> {
  return buildApp({
    env: crearEnv(extra),
    db,
    loggerOptions: { level: "silent" },
  });
}

/** Extrae el token `sid` de la cookie seteada por el servidor. */
function sidToken(setCookie: string[] | string | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(raw, "debe existir Set-Cookie con la sesión").toBeDefined();
  const match = new RegExp(`(?:^|;\\s*)${SESION_COOKIE}=([^;]+)`).exec(
    raw ?? "",
  );
  expect(match, "Set-Cookie debe contener la cookie sid").not.toBeNull();
  return match?.[1] ?? "";
}

async function login(
  app: FastifyInstance,
  email = OPERADOR_EMAIL,
  password = OPERADOR_PASSWORD,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("auth — login/logout/me (T-07)", () => {
  it("VNG-S1/CA-VNG-03: login ok → 200 + cookie httpOnly con TTL 7 días; /me autorizado", async () => {
    const db = await prepararBd();
    const app = await crearApp(db);

    const res = await login(app);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    // OperadorSesion: solo ids/nombre/email, nunca secrets (hash).
    const cuerpo = res.json();
    expect(Object.keys(cuerpo).sort()).toEqual(["email", "nombre", "operador_id"]);
    expect(cuerpo.email).toBe(OPERADOR_EMAIL);
    expect(cuerpo.nombre).toBe("Operador Demo");
    expect(cuerpo.operador_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(cuerpo)).not.toContain("password");

    // Cookie sid: opaca, httpOnly, SameSite=Lax, sin Secure en dev.
    const setCookie = res.headers["set-cookie"] as string[];
    const primerCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(primerCookie ?? "").toContain("sid=");
    expect(primerCookie ?? "").toContain("HttpOnly");
    expect(primerCookie ?? "").toContain("SameSite=Lax");
    expect(primerCookie ?? "").toContain(`Max-Age=${7 * SEGUNDOS_POR_DIA}`);
    expect(primerCookie ?? "").not.toContain("Secure");

    // Token opaco: 32 bytes base64url (≥128 bits, RB-CMR-01 análogo a auth).
    const token = sidToken(setCookie);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // La BD guarda solo sha256(token) — nunca el token en claro (RB-VNG-05).
    expect(hashToken(token)).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    const sesion = await db.query.sesiones.findFirst({
      where: eq(sesiones.token_hash, hashToken(token)),
    });
    expect(sesion).toBeDefined();
    expect(sesion?.token_hash).not.toBe(token);
    expect(sesion?.revoked_at).toBeNull();

    // TTL 7 días (CA-VNG-03).
    const ttlMs = (sesion!.expires_at.getTime() - sesion!.created_at.getTime());
    expect(Math.abs(ttlMs - TTL_SESION_MS)).toBeLessThan(5_000);

    // VNG-S1: la sesión otorga acceso a /auth/me.
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: `sid=${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(cuerpo);

    await app.close();
  });

  it("VNG-S2/CA-VNG-03: 5 intentos fallidos → 401 y el 6.º intento → 429 (bloqueo 15 min)", async () => {
    const db = await prepararBd();
    const app = await crearApp(db);

    for (let i = 0; i < 5; i += 1) {
      const fallido = await login(app, OPERADOR_EMAIL, "password-incorrecta");
      expect(fallido.statusCode).toBe(401);
      expect(fallido.headers["content-type"]).toContain("application/problem+json");
      expect(fallido.json().type).toBe(`${PROBLEM_BASE_URI}/no-autorizado`);
    }

    // El 6.º intento —incluso con credenciales correctas— es 429 (lockout).
    const sexto = await login(app);
    expect(sexto.statusCode).toBe(429);
    expect(sexto.headers["content-type"]).toContain("application/problem+json");
    expect(sexto.json().type).toBe(`${PROBLEM_BASE_URI}/demasiadas-peticiones`);

    await app.close();
  });

  it("VNG-S2: un login exitoso NO consume ni reinicia el contador de intentos fallidos — 3 fallos + 1 ok + 2 fallos → el siguiente intento es 429", async () => {
    const db = await prepararBd();
    const app = await crearApp(db);

    // 3 fallos → contador = 3 (mismo cliente: IP+email, clave por defecto).
    for (let i = 0; i < 3; i += 1) {
      const fallido = await login(app, OPERADOR_EMAIL, "password-incorrecta");
      expect(fallido.statusCode).toBe(401);
    }

    // 1 login exitoso: el contador NO se consume ni se reinicia (queda en 3).
    // Si el éxito reiniciara el contador, el último intento devolvería 200.
    const ok = await login(app);
    expect(ok.statusCode).toBe(200);

    // 2 fallos más → contador = 5 (umbral alcanzado).
    for (let i = 0; i < 2; i += 1) {
      const fallido = await login(app, OPERADOR_EMAIL, "password-incorrecta");
      expect(fallido.statusCode).toBe(401);
    }

    // El siguiente intento —incluso con credenciales correctas— es 429 (lockout).
    const bloqueado = await login(app);
    expect(bloqueado.statusCode).toBe(429);
    expect(bloqueado.headers["content-type"]).toContain("application/problem+json");
    expect(bloqueado.json().type).toBe(`${PROBLEM_BASE_URI}/demasiadas-peticiones`);

    await app.close();
  });

  it("RB-VNG-05 (logout): 204 revoca la sesión y la invalida para /me", async () => {
    const db = await prepararBd();
    const app = await crearApp(db);

    const res = await login(app);
    const token = sidToken(res.headers["set-cookie"]);

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: `sid=${token}` },
    });
    expect(logout.statusCode).toBe(204);

    // La sesión queda revocada en BD (RB-VNG-05: logout invalida).
    const sesion = await db.query.sesiones.findFirst({
      where: eq(sesiones.token_hash, hashToken(token)),
    });
    expect(sesion?.revoked_at).not.toBeNull();

    // La misma cookie ya no accede a /me, ni permite logout otra vez.
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: `sid=${token}` },
    });
    expect(me.statusCode).toBe(401);

    const segundoLogout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: `sid=${token}` },
    });
    expect(segundoLogout.statusCode).toBe(401);

    await app.close();
  });

  it("VNG-S7: sin cookie → 401 (problem+json); cookie inválida → 401", async () => {
    const db = await prepararBd();
    const app = await crearApp(db);

    const sinCookie = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(sinCookie.statusCode).toBe(401);
    expect(sinCookie.headers["content-type"]).toContain("application/problem+json");
    expect(sinCookie.json().type).toBe(`${PROBLEM_BASE_URI}/no-autorizado`);

    const cookieFalsa = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: "sid=token-inventado-que-no-existe" },
    });
    expect(cookieFalsa.statusCode).toBe(401);

    await app.close();
  });

  it("una sesión expirada (TTL vencido) no autoriza /me — CA-VNG-03", async () => {
    const db = await prepararBd();
    const app = await crearApp(db);

    const operador = await db.query.operadores.findFirst({
      where: eq(operadores.email, OPERADOR_EMAIL),
    });
    expect(operador).toBeDefined();

    const tokenExpirado = randomBytes(32).toString("base64url");
    await db.insert(sesiones).values({
      operador_id: operador!.id,
      tenant_id: operador!.tenant_id,
      token_hash: hashToken(tokenExpirado),
      expires_at: new Date(Date.now() - 60_000),
    });

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: `sid=${tokenExpirado}` },
    });
    expect(me.statusCode).toBe(401);

    await app.close();
  });

  it("el middleware de sesión es reutilizable en rutas de negocio futuras (401 sin cookie)", async () => {
    const db = await prepararBd();
    const app = await crearApp(db);
    const res = await login(app);
    const token = sidToken(res.headers["set-cookie"]);
    await app.close();

    // App mínima con una ruta protegida arbitraria — igual wiring que buildApp.
    const privada = Fastify({ logger: false });
    await privada.register(cookie);
    privada.setErrorHandler(createErrorHandler(privada.log));
    privada.get(
      "/api/v1/privado",
      { preHandler: crearRequireSession(db) },
      async (request) => ({
        tenant_id: request.sesion?.tenant_id ?? null,
        operador_id: request.sesion?.operador.operador_id ?? null,
      }),
    );

    const sinCookie = await privada.inject({ method: "GET", url: "/api/v1/privado" });
    expect(sinCookie.statusCode).toBe(401);

    const conCookie = await privada.inject({
      method: "GET",
      url: "/api/v1/privado",
      headers: { cookie: `sid=${token}` },
    });
    expect(conCookie.statusCode).toBe(200);
    expect(conCookie.json().tenant_id).toBeTruthy();
    expect(conCookie.json().operador_id).toBeTruthy();

    await privada.close();
  });

  it("credenciales inválidas o incompletas → 422 problem+json con errores[] por campo", async () => {
    const db = await prepararBd();
    const app = await crearApp(db);

    const invalido = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "no-es-un-email", password: "1234567" },
    });
    expect(invalido.statusCode).toBe(422);
    expect(invalido.headers["content-type"]).toContain("application/problem+json");
    expect(invalido.json().type).toBe(`${PROBLEM_BASE_URI}/validacion`);
    const campos = (invalido.json().errores as Array<{ campo: string }>).map(
      (e) => e.campo,
    );
    expect(campos).toContain("email");
    expect(campos).toContain("password");

    await app.close();
  });

  it("VNG-S2 (alcance del contador): el bloqueo es por IP+email — otro origen conserva su ventana", async () => {
    const db = await prepararBd();
    const app = await crearApp(db);

    const origenA = "127.0.0.2";
    const origenB = "127.0.0.3";
    for (let i = 0; i < 5; i += 1) {
      const fallido = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress: origenA,
        payload: { email: OPERADOR_EMAIL, password: "password-incorrecta" },
      });
      expect(fallido.statusCode).toBe(401);
    }

    // Mismo origen + misma cuenta → bloqueado aunque la credencial sea válida.
    const bloqueado = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: origenA,
      payload: { email: OPERADOR_EMAIL, password: OPERADOR_PASSWORD },
    });
    expect(bloqueado.statusCode).toBe(429);

    // Otro origen con la misma cuenta conserva su ventana (login ok).
    const otroOrigen = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: origenB,
      payload: { email: OPERADOR_EMAIL, password: OPERADOR_PASSWORD },
    });
    expect(otroOrigen.statusCode).toBe(200);

    await app.close();
  });

  it("email desconocido → 401 idéntico al de password incorrecto (sin enumeración de cuentas)", async () => {
    const db = await prepararBd();
    const app = await crearApp(db);

    const emailInexistente = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nadie@demo.local", password: OPERADOR_PASSWORD },
    });
    expect(emailInexistente.statusCode).toBe(401);

    const passwordIncorrecto = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: OPERADOR_EMAIL, password: "password-incorrecta" },
    });
    expect(passwordIncorrecto.statusCode).toBe(401);

    // Mismo problem+json: el 401 no revela cuál campo falló.
    expect(emailInexistente.json()).toEqual(passwordIncorrecto.json());

    await app.close();
  });

  it("RB-VNG-05: Secure(true) en cookie cuando COOKIE_SECURE=1 (producción)", async () => {
    const db = await prepararBd();
    const app = await crearApp(db, { COOKIE_SECURE: "true" });

    const res = await login(app);
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers["set-cookie"] as string[];
    const primerCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(primerCookie ?? "").toContain("Secure");

    await app.close();
  });
});