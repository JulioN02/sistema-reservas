import { defineConfig } from "vitest/config";

/**
 * Configuración del paquete API.
 *
 * Coverage gate (T-20): umbral de ≥70% de LÍNEAS en los servicios críticos
 * (agendaService, turnoService, notificationService, reminderScheduler,
 * metricasService, authService). El gate se exige en CI vía
 * `pnpm --filter @sistema-reservas/api test:coverage`.
 *
 * Los umbrales usan patrones glob por archivo: solo se exigen para los
 * servicios críticos; el resto del código se mide pero no bloquea.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Los tests de integración comparten la BD de test: los archivos se
    // ejecutan en serie para evitar carreras (truncate/seed entre archivos).
    fileParallelism: false,
    // Migrate + seed + argon2id superan los 5s por defecto bajo carga (CI):
    // margen amplio para la corrida desde la raíz del monorepo.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/tests/**",
        "src/**/*.test.ts",
        "src/db/migrations/**",
      ],
      // Umbral de líneas por servicio crítico (T-20, ≥70%).
      thresholds: {
        "src/services/agendaService.ts": { lines: 70 },
        "src/services/turnoService.ts": { lines: 70 },
        "src/services/metricasService.ts": { lines: 70 },
        "src/services/authService.ts": { lines: 70 },
        "src/notificaciones/notificationService.ts": { lines: 70 },
        "src/notificaciones/reminderScheduler.ts": { lines: 70 },
      },
    },
  },
});
