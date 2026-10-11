import { z } from "zod";
import type { components } from "@sistema-reservas/contracts";
import {
  BadRequestError,
  ValidationError,
  type ErrorCampo,
} from "../infra/errors";

/**
 * DTOs del módulo agenda (T-08/T-09). zod es la fuente de verdad de
 * validación en runtime (RNF-03, AD-05); los tipos de respuesta se alinean
 * al contrato OpenAPI (ServicioPublico, DiaAgenda, AgendaResponse) para
 * evitar deriva YAML ↔ zod (R-D8).
 *
 * Convención de errores (contrato /agenda): 400 para petición mal formada
 * (parámetros de query inválidos) y 422 para validación semántica (rangos
 * invertidos). Las mutaciones de negocio devuelven 422 con `errores[]`.
 */

/** Fecha YYYY-MM-DD válida (formato del contrato, zona del negocio). */
const fechaSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha con formato YYYY-MM-DD.")
  .refine((v) => !Number.isNaN(Date.parse(v)), "Fecha inválida.");

/** Query pública de agenda: servicio + rango [desde, hasta) por día. */
export const agendaQuerySchema = z.object({
  servicio_id: z.string().uuid("servicio_id debe ser un UUID."),
  desde: fechaSchema,
  hasta: fechaSchema,
});

export type AgendaQuery = z.infer<typeof agendaQuerySchema>;

/**
 * Valida la query de agenda: forma mal formada → 400 (BadRequestError);
 * rango semánticamente inválido (hasta <= desde) → 422 (ValidationError).
 */
export function parsearAgendaQuery(query: unknown): AgendaQuery {
  const forma = agendaQuerySchema.safeParse(query);
  if (!forma.success) {
    const detalle = forma.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new BadRequestError(`Parámetros de query inválidos: ${detalle}`);
  }
  if (forma.data.hasta <= forma.data.desde) {
    const errores: ErrorCampo[] = [
      {
        campo: "hasta",
        mensaje: "`hasta` debe ser posterior a `desde`.",
      },
    ];
    throw new ValidationError(errores);
  }
  return forma.data;
}

// --- Tipos de respuesta alineados al contrato OpenAPI ---

export type ServicioPublico = components["schemas"]["ServicioPublico"];
export type DiaAgenda = components["schemas"]["DiaAgenda"];
export type AgendaResponse = components["schemas"]["AgendaResponse"];
export type Horario = components["schemas"]["Horario"];
export type Bloque = components["schemas"]["Bloque"];
export type Servicio = components["schemas"]["Servicio"];

// --- Gestión de agenda del negocio (T-09) ---

/** Valida que `tz` sea una zona horaria IANA soportada (AD-06). */
function esZonaHorariaValida(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Hora HH:MM[:SS] normalizada a HH:MM:SS (formato de la columna time). */
const horaSchema = z
  .string()
  .regex(
    /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/,
    "Hora con formato HH:MM[:SS].",
  )
  .transform((v) => (v.length === 5 ? `${v}:00` : v));

/** HorarioInput — contrato: dia_semana 1–7, horas locales de pared + timezone. */
export const horarioInputSchema = z
  .object({
    dia_semana: z.number().int("dia_semana debe ser un entero.").min(1).max(7),
    hora_inicio: horaSchema,
    hora_fin: horaSchema,
    timezone: z
      .string()
      .min(1, "timezone es obligatoria.")
      .refine(esZonaHorariaValida, "Zona horaria IANA inválida."),
  })
  .refine((h) => h.hora_inicio < h.hora_fin, {
    message: "hora_inicio debe ser anterior a hora_fin.",
    path: ["hora_fin"],
  });

export type HorarioInput = z.infer<typeof horarioInputSchema>;

/** Fecha-hora ISO 8601 (con offset) o instancia Date; normaliza a Date. */
const fechaIsoSchema = z
  .string()
  .datetime({ offset: true, message: "Fecha ISO 8601 requerida." })
  .transform((v) => new Date(v))
  .or(z.date());

/** BloqueInput — contrato: rango [fecha_inicio, fecha_fin], motivo opcional. */
export const bloqueInputSchema = z
  .object({
    fecha_inicio: fechaIsoSchema,
    fecha_fin: fechaIsoSchema,
    motivo: z.string().max(255, "motivo demasiado largo.").nullable().optional(),
  })
  .refine((b) => b.fecha_fin >= b.fecha_inicio, {
    message: "fecha_fin debe ser mayor o igual a fecha_inicio.",
    path: ["fecha_fin"],
  });

export type BloqueInput = z.infer<typeof bloqueInputSchema>;

/** ServicioInput — contrato: duración múltiplo de 15 (RB-AGD-01). */
export const servicioInputSchema = z.object({
  nombre: z.string().trim().min(1, "nombre es obligatorio.").max(120),
  duracion_min: z
    .number()
    .int("duracion_min debe ser un entero.")
    .min(15, "duracion_min mínimo 15 minutos.")
    .refine((v) => v % 15 === 0, "duracion_min debe ser múltiplo de 15."),
  precio: z.number().nonnegative("precio no puede ser negativo.").nullable().optional(),
  booking_window_days: z
    .number()
    .int()
    .min(1, "booking_window_days mínimo 1 día.")
    .max(90, "booking_window_days máximo 90 días.")
    .optional(),
  cancellation_grace_minutes: z
    .number()
    .int()
    .min(30, "cancellation_grace_minutes mínimo 30 minutos.")
    .max(1440, "cancellation_grace_minutes máximo 1440 minutos.")
    .optional(),
  activo: z.boolean().optional(),
});

export type ServicioInput = z.infer<typeof servicioInputSchema>;

/** ServicioParametrosInput — PATCH parcial (contrato: 3 campos editables). */
export const servicioParametrosSchema = z.object({
  booking_window_days: z
    .number()
    .int()
    .min(1, "booking_window_days mínimo 1 día.")
    .max(90, "booking_window_days máximo 90 días.")
    .optional(),
  cancellation_grace_minutes: z
    .number()
    .int()
    .min(30, "cancellation_grace_minutes mínimo 30 minutos.")
    .max(1440, "cancellation_grace_minutes máximo 1440 minutos.")
    .optional(),
  activo: z.boolean().optional(),
});

export type ServicioParametros = z.infer<typeof servicioParametrosSchema>;

/** UUID de path param (rutas /{id}). */
const uuidSchema = z
  .string()
  .uuid("El identificador debe ser un UUID.");

export type IdPath = z.infer<typeof uuidSchema>;

/** Convierte issues de zod al shape `errores[]` del contrato (422). */
function erroresDeIssues(issues: z.ZodIssue[]): ErrorCampo[] {
  return issues.map((issue) => ({
    campo: issue.path.join(".") || "body",
    mensaje: issue.message,
  }));
}

/** Valida el cuerpo del horario (422 problem+json con `errores[]`). */
export function parsearHorarioInput(cuerpo: unknown): HorarioInput {
  const resultado = horarioInputSchema.safeParse(cuerpo);
  if (!resultado.success) {
    throw new ValidationError(erroresDeIssues(resultado.error.issues));
  }
  return resultado.data;
}

/** Valida el cuerpo del bloque (422 problem+json con `errores[]`). */
export function parsearBloqueInput(cuerpo: unknown): BloqueInput {
  const resultado = bloqueInputSchema.safeParse(cuerpo);
  if (!resultado.success) {
    throw new ValidationError(erroresDeIssues(resultado.error.issues));
  }
  return resultado.data;
}

/** Valida el cuerpo del servicio (422 problem+json con `errores[]`). */
export function parsearServicioInput(cuerpo: unknown): ServicioInput {
  const resultado = servicioInputSchema.safeParse(cuerpo);
  if (!resultado.success) {
    throw new ValidationError(erroresDeIssues(resultado.error.issues));
  }
  return resultado.data;
}

/** Valida el PATCH de parámetros (422 problem+json con `errores[]`). */
export function parsearParametrosServicio(cuerpo: unknown): ServicioParametros {
  const resultado = servicioParametrosSchema.safeParse(cuerpo);
  if (!resultado.success) {
    throw new ValidationError(erroresDeIssues(resultado.error.issues));
  }
  return resultado.data;
}

/** Valida el path param `id` (422 problem+json con `errores[]`). */
export function parsearId(id: unknown): string {
  const resultado = uuidSchema.safeParse(id);
  if (!resultado.success) {
    throw new ValidationError(erroresDeIssues(resultado.error.issues));
  }
  return resultado.data;
}