import { z } from "zod";
import type { components } from "@sistema-reservas/contracts";
import { ValidationError, type ErrorCampo } from "../infra/errors";

/**
 * DTOs del módulo auth (T-07). zod es la fuente de verdad de validación en
 * runtime (RNF-03, AD-05); los tipos de respuesta se alinean al contrato
 * OpenAPI (OperadorSesion) para evitar deriva YAML ↔ zod (R-D8).
 */

/** CredencialesLogin — contrato: email (formato email) + password (≥ 8). */
export const credencialesLoginSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("El email no tiene un formato válido."),
  password: z.string().min(8, "El password debe tener al menos 8 caracteres."),
});

export type CredencialesLogin = z.infer<typeof credencialesLoginSchema>;

/** OperadorSesion — mismo shape que el contrato OpenAPI (sin secrets). */
export type OperadorSesion = components["schemas"]["OperadorSesion"];

/**
 * Sesión activa resuelta por el middleware de auth (rutas negocio):
 * identidad del operador + tenant de la sesión (aislamiento, RB-INT-01).
 */
export interface SesionActiva {
  sesion_id: string;
  tenant_id: string;
  operador: OperadorSesion;
}

/**
 * Valida el cuerpo del login y lanza el error de dominio correspondiente
 * (422 problem+json con `errores[]` por campo — contrato Validacion).
 */
export function parsearCredenciales(cuerpo: unknown): CredencialesLogin {
  const resultado = credencialesLoginSchema.safeParse(cuerpo);
  if (!resultado.success) {
    const errores: ErrorCampo[] = resultado.error.issues.map((issue) => ({
      campo: issue.path.join(".") || "body",
      mensaje: issue.message,
    }));
    throw new ValidationError(errores);
  }
  return resultado.data;
}