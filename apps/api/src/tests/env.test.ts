import { describe, expect, it } from "vitest";
import { parseEnv } from "../config/env";

describe("parseEnv — validación de entorno (fail-fast)", () => {
  it("arranca con el entorno mínimo (solo DATABASE_URL)", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/sistema_reservas",
    });
    expect(env.DATABASE_URL).toBe(
      "postgres://postgres:postgres@localhost:5432/sistema_reservas",
    );
    expect(env.DEFAULT_TENANT_SLUG).toBe("demo");
    expect(env.PORT).toBe(3000);
    expect(env.SESSION_TTL_DAYS).toBe(7);
    expect(env.REMINDER_LEAD_MIN).toBe(1440);
    expect(env.NOTIFICATION_CHANNEL).toBe("log");
    expect(env.COOKIE_SECURE).toBe(false);
  });

  it("falla sin DATABASE_URL", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it("falla con NOTIFICATION_CHANNEL inválido", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgres://x",
        NOTIFICATION_CHANNEL: "sms",
      }),
    ).toThrow(/NOTIFICATION_CHANNEL/);
  });

  it("falla con DEFAULT_TENANT_SLUG inválido", () => {
    expect(() =>
      parseEnv({ DATABASE_URL: "postgres://x", DEFAULT_TENANT_SLUG: "Mi Negocio!" }),
    ).toThrow(/DEFAULT_TENANT_SLUG/);
  });

  it("parsea booleanos y números desde strings", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://x",
      COOKIE_SECURE: "true",
      PORT: "8080",
      SESSION_TTL_DAYS: "14",
    });
    expect(env.COOKIE_SECURE).toBe(true);
    expect(env.PORT).toBe(8080);
    expect(env.SESSION_TTL_DAYS).toBe(14);
  });
});