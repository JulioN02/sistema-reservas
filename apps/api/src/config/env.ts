import { z } from "zod";

/**
 * Esquema de entorno del API. La validación se hace en el arranque
 * (fail-fast): un entorno inválido impide que el servidor levante.
 *
 * Fuente de verdad de configuración (RNF-03): los valores válidos acá son los
 * que el resto de la aplicación puede asumir.
 */

const booleanFromString = z.preprocess((valor) => {
  if (typeof valor === "string") return valor === "true" || valor === "1";
  return valor;
}, z.boolean());

export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatoria"),
  /** Slug del tenant público (único tenant activo en v1). */
  DEFAULT_TENANT_SLUG: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "slug con minúsculas, dígitos y guiones")
    .default("demo"),
  /** Origen específico de la SPA (nunca `*`). */
  CORS_ORIGIN: z.string().url().default("http://localhost:5173"),
  /** Secure en la cookie de sesión (solo producción). */
  COOKIE_SECURE: booleanFromString.default(false),
  /** TTL de sesión del operador (RB-VNG-05). */
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  /** Lead de recordatorio en minutos (RB-CMR-03). */
  REMINDER_LEAD_MIN: z.coerce.number().int().positive().default(1440),
  /** Canal de notificaciones (dev: log; prod: email). */
  NOTIFICATION_CHANNEL: z.enum(["email", "log"]).default("log"),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detalle = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Configuración de entorno inválida: ${detalle}`);
  }
  return parsed.data;
}