import { defineConfig } from "vitest/config";

/**
 * Configuración raíz del monorepo (API `test.projects`, vitest >= 3.2;
 * reemplaza al obsoleto vitest.workspace.ts).
 *
 * Cada paquete es un proyecto vitest. Los proyectos corren en paralelo
 * entre sí; dentro del proyecto api los tests de integración comparten la
 * BD de test y se serializan con `fileParallelism: false` (migrate/truncate/
 * seed entre archivos — carreras si corren a la vez).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "@sistema-reservas/api",
          environment: "node",
          include: ["apps/api/src/**/*.test.ts"],
          // Serializa los archivos de tests del api (comparten la BD de test).
          fileParallelism: false,
          // Migrate + seed + argon2id superan los 5s por defecto bajo carga.
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "@sistema-reservas/web",
          environment: "jsdom",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          setupFiles: ["apps/web/src/__tests__/setup.ts"],
        },
      },
      {
        test: {
          name: "@sistema-reservas/contracts",
          environment: "node",
          include: ["packages/contracts/src/**/*.test.ts"],
        },
      },
    ],
  },
});