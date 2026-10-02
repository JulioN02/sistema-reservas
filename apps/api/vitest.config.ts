import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Los tests de integración comparten la BD de test: los archivos se
    // ejecutan en serie para evitar carreras (truncate/seed entre archivos).
    fileParallelism: false,
  },
});