import { buildApp } from "./app";
import { parseEnv } from "./config/env";
import { createDb } from "./db";
import { buildLoggerOptions } from "./infra/logger";
import { crearNotificationService } from "./notificaciones/notificationService";
import {
  detenerScheduler,
  iniciarScheduler,
} from "./notificaciones/reminderScheduler";

/**
 * Punto de entrada del API. Valida el entorno (fail-fast), construye la app,
 * arranca el scheduler de recordatorios (diseño §6.2, instancia única) y
 * escucha. Maneja SIGINT/SIGTERM con cierre ordenado.
 */
async function main(): Promise<void> {
  const env = parseEnv();
  const db = createDb(env.DATABASE_URL);
  const app = await buildApp({
    env,
    db,
    loggerOptions: buildLoggerOptions(env.LOG_LEVEL),
  });

  // Cola de recordatorios: sweep cada 60 s (no-op en dev con LogChannel).
  const notificaciones = crearNotificationService(env, app.log);
  iniciarScheduler(db, notificaciones, {
    leadMin: env.REMINDER_LEAD_MIN,
    logger: app.log,
  });

  const cerrar = async (senal: string): Promise<void> => {
    app.log.info({ senal }, "cerrando servidor");
    detenerScheduler();
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