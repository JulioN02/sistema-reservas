import { defineConfig, devices } from "@playwright/test";

/**
 * Configuración E2E (T-24) — Playwright contra el stack Docker Compose completo
 * (api + web + db), NO contra un servidor mockeado.
 *
 * Requisitos:
 *  - El stack debe estar ya levantado; la URL base se toma de `E2E_BASE_URL`
 *    (por defecto http://localhost:8080). Ver docs/deploy.md §6 para levantar
 *    un stack aislado en otros puertos.
 *  - Para resultados reproducibles, correr contra un stack limpio (nuevo
 *    proyecto compose / `down -v` antes de subir).
 *
 * `workers: 1` y `fullyParallel: false`: los tests crean turnos y no deben
 * competir por el mismo slot (claim atómico → 409).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8080",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
