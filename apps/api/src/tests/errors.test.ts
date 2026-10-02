import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";
import {
  ConflictError,
  PROBLEM_BASE_URI,
  ValidationError,
} from "../infra/errors";

const env = parseEnv({
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/sistema_reservas",
});

const loggerOptions = { level: "silent" as const };

function loggerEnMemoria(): { loggerOptions: { level: "info"; stream: Writable }; lineas: string[] } {
  const lineas: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lineas.push(String(chunk));
      callback();
    },
  });
  return { loggerOptions: { level: "info", stream }, lineas };
}

describe("manejador central de errores (RFC 7807)", () => {
  it("mapea errores de validación de dominio → 422 con errores[]", async () => {
    const app = await buildApp({
      env,
      loggerOptions,
      checkDb: async () => true,
    });
    app.get("/demo/validacion", () => {
      throw new ValidationError([
        { campo: "cliente.nombre", mensaje: "El nombre es obligatorio." },
        { campo: "consentimiento", mensaje: "Debe aceptar el consentimiento." },
      ]);
    });

    const res = await app.inject({ method: "GET", url: "/demo/validacion" });
    expect(res.statusCode).toBe(422);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const body = res.json();
    expect(body.type).toBe(`${PROBLEM_BASE_URI}/validacion`);
    expect(body.status).toBe(422);
    expect(body.errores).toHaveLength(2);
    expect(body.errores[0]).toEqual({
      campo: "cliente.nombre",
      mensaje: "El nombre es obligatorio.",
    });
    await app.close();
  });

  it("mapea conflictos → 409 con alternativas[]", async () => {
    const app = await buildApp({
      env,
      loggerOptions,
      checkDb: async () => true,
    });
    app.post("/demo/conflicto", () => {
      throw new ConflictError("El slot solicitado ya no está disponible.", [
        "2026-10-05T09:30:00.000Z|svc_abc",
        "2026-10-05T10:00:00.000Z|svc_abc",
      ]);
    });

    const res = await app.inject({
      method: "POST",
      url: "/demo/conflicto",
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.type).toBe(`${PROBLEM_BASE_URI}/conflicto`);
    expect(body.alternativas).toHaveLength(2);
    await app.close();
  });

  it("nunca filtra internals en errores inesperados → 500 genérico + log con request_id", async () => {
    const { loggerOptions: opciones, lineas } = loggerEnMemoria();
    const app = await buildApp({ env, loggerOptions: opciones, checkDb: async () => true });
    app.get("/demo/500", () => {
      throw new Error("secreto interno de la base de datos");
    });

    const res = await app.inject({ method: "GET", url: "/demo/500" });
    expect(res.statusCode).toBe(500);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const body = res.json();
    expect(body.type).toBe(`${PROBLEM_BASE_URI}/error-interno`);
    expect(body.detail).not.toContain("secreto interno");
    expect(JSON.stringify(body)).not.toContain("secreto interno");

    // El detalle queda en el log estructurado con request_id (RNF-07).
    const log = lineas.join("");
    expect(log).toContain("error no controlado");
    expect(log).toContain("secreto interno de la base de datos");
    expect(log).toContain("request_id");
    await app.close();
  });

  it("mapea errores de validación de Fastify (schema) → 422 problem+json", async () => {
    const app = await buildApp({
      env,
      loggerOptions,
      checkDb: async () => true,
    });
    app.post(
      "/demo/schema",
      { schema: { body: { type: "object", required: ["nombre"] } } },
      () => ({ ok: true }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/demo/schema",
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.errores).toBeDefined();
    expect(body.errores[0].campo).toBe("body");
    await app.close();
  });
});