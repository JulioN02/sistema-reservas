import { describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { parseEnv } from "../config/env";

const env = parseEnv({
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/sistema_reservas",
});

const loggerOptions = { level: "silent" as const };

describe("GET /api/v1/health", () => {
  it("devuelve 200 {status: ok, db: up} cuando la BD responde", async () => {
    const app = await buildApp({
      env,
      loggerOptions,
      checkDb: async () => true,
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toEqual({ status: "ok", db: "up" });
    await app.close();
  });

  it("reporta db: down cuando la BD no responde sin dejar de responder 200", async () => {
    const app = await buildApp({
      env,
      loggerOptions,
      checkDb: async () => false,
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "down" });
    await app.close();
  });

  it("responde 404 en rutas desconocidas con problem+json", async () => {
    const app = await buildApp({
      env,
      loggerOptions,
      checkDb: async () => true,
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/no-existe" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    await app.close();
  });
});