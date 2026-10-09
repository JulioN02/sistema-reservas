import { buildApp } from "./app";
import { parseEnv } from "./config/env";
import { buildLoggerOptions } from "./infra/logger";

/**
 * Punto de entrada del API. Valida el entorno (fail-fast), construye la app y
 * escucha. Maneja SIGINT/SIGTERM con cierre ordenado.
 */
async function main(): Promise<void> {
  const env = parseEnv();
  const app = await buildApp({
    env,
    loggerOptions: buildLoggerOptions(env.LOG_LEVEL),
  });

  const cerrar = async (senal: string): Promise<void> => {
    app.log.info({ senal }, "cerrando servidor");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void cerrar("SIGINT"));
  process.on("SIGTERM", () => void cerrar("SIGTERM"));

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});