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