import { z } from "zod";
import type { components } from "@sistema-reservas/contracts";
import { ValidationError, type ErrorCampo } from "../infra/errors";

/**
 * DTOs del módulo turnos (T-10). zod es la fuente de verdad de validación
 * en runtime (RNF-03, AD-05); los tipos de respuesta se alinean al contrato
 * OpenAPI (TurnoCreado) para evitar deriva YAML ↔ zod (R-D8).
 *
 * Validaciones del contrato POST /turnos (TurnoCrearInput):
 * - canal de contacto obligatorio: email y/o teléfono (CA-RST-03).
 * - consentimiento obligatorio y debe ser `true` (PRV-01).
 * - slot_key = `<inicio_utc ISO8601>|<servicio_id>` (RB-AGD-07); el
 *   servicio del slot_key debe coincidir con `servicio_id` del cuerpo.
 *
 * Las validaciones temporales (pasado, ventana de reserva) necesitan el
 * reloj y los parámetros del servicio, por lo que viven en el servicio
 * (TurnoService.crear) — ver RST-S6/CA-RST-04.
 */

/** Descompone `slot_key` = `<inicio_utc ISO8601>|<servicio_id>` en sus partes. */
export function descomponerSlotKey(slotKey: string): {
  inicio_utc: Date;
  servicio_id: string;
} | null {
  const partes = slotKey.split("|");
  if (partes.length !== 2) return null;
  const [inicioRaw, servicioId] = partes as [string, string];
  const inicio = new Date(inicioRaw);
  if (Number.isNaN(inicio.getTime())) return null;
  return { inicio_utc: inicio, servicio_id: servicioId };
}

/** Cliente de la reserva: nombre + al menos un canal (email y/o teléfono). */
export const clienteReservaSchema = z
  .object({
    nombre: z
      .string()
      .trim()
      .min(1, "nombre es obligatorio.")
      .max(120, "nombre demasiado largo."),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("El email no tiene un formato válido.")
      .nullish(),
    telefono: z
      .string()
      .trim()
      .max(40, "telefono demasiado largo.")
      .nullish(),
  })
  .refine((c) => c.email != null || c.telefono != null, {
    message: "Debe aportar al menos un canal de contacto (email y/o teléfono).",
  });

export type ClienteReserva = z.infer<typeof clienteReservaSchema>;

/**
 * Cuerpo de POST /turnos (TurnoCrearInput): valida el formato del slot_key
 * y la coherencia con `servicio_id`; `consentimiento` debe ser `true`.
 */
export const turnoCrearSchema = z
  .object({
    servicio_id: z.string().uuid("servicio_id debe ser un UUID."),
    slot_key: z
      .string()
      .transform((valor, ctx) => {
        const descompuesto = descomponerSlotKey(valor);
        if (descompuesto === null) {
          ctx.addIssue({
            code: "custom",
            message: "slot_key con formato `<inicio_utc ISO8601>|<servicio_id>`.",
          });
          return z.NEVER;
        }
        return descompuesto;
      }),
    cliente: clienteReservaSchema,
    consentimiento: z
      .boolean()
      .refine((v) => v === true, {
        message: "El consentimiento debe ser true (PRV-01).",
      }),
  })
  .refine((t) => t.slot_key.servicio_id === t.servicio_id, {
    message: "slot_key no corresponde al servicio indicado.",
    path: ["slot_key"],
  });

export type TurnoCrearInput = z.infer<typeof turnoCrearSchema>;

/** TurnoCreado — mismo shape que el contrato OpenAPI (201). */
export type TurnoCreado = components["schemas"]["TurnoCreado"];

/** TurnoGestion — GET /turnos/{token} (contrato §4.2, aditivo, T-11). */
export type TurnoGestion = components["schemas"]["TurnoGestion"];

/** TurnoAccionResultado — POST /turnos/{token}/confirmar|cancelar|reagendar
 * y POST /turnos/{id}/acciones (200, T-11/T-14). */
export type TurnoAccionResultado = components["schemas"]["TurnoAccionResultado"];

/**
 * Acciones de negocio (POST /turnos/{id}/acciones, T-14) — const types
 * (nunca union literals directas). Espejo del enum `accion` del contrato.
 */
export const ACCION_TURNO = {
  Confirmar: "confirmar",
  Cancelar: "cancelar",
  Completado: "completado",
  NoShow: "no_show",
} as const;
export type AccionTurno = (typeof ACCION_TURNO)[keyof typeof ACCION_TURNO];

/** Cuerpo de POST /turnos/{token}/reagendar: solo el nuevo `slot_key`. */
export const turnoReagendarSchema = z.object({
  slot_key: z.string().transform((valor, ctx) => {
    const descompuesto = descomponerSlotKey(valor);
    if (descompuesto === null) {
      ctx.addIssue({
        code: "custom",
        message: "slot_key con formato `<inicio_utc ISO8601>|<servicio_id>`.",
      });
      return z.NEVER;
    }
    return descompuesto;
  }),
});

export type TurnoReagendarInput = z.infer<typeof turnoReagendarSchema>["slot_key"];

/**
 * Cuerpo de POST /turnos/{id}/acciones (AccionTurnoInput): `motivo` es
 * obligatorio para cancelar (CA-CRG-04, RB-VNG-04); opcional para el resto.
 */
export const accionTurnoSchema = z
  .object({
    accion: z.enum([
      ACCION_TURNO.Confirmar,
      ACCION_TURNO.Cancelar,
      ACCION_TURNO.Completado,
      ACCION_TURNO.NoShow,
    ]),
    motivo: z
      .string()
      .trim()
      .max(500, "motivo demasiado largo.")
      .nullish(),
  })
  .superRefine((valor, ctx) => {
    if (
      valor.accion === ACCION_TURNO.Cancelar &&
      (valor.motivo === null || valor.motivo === undefined || valor.motivo === "")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["motivo"],
        message: "motivo es obligatorio para cancelar (CA-CRG-04).",
      });
    }
  });

export type AccionTurnoInput = z.infer<typeof accionTurnoSchema>;

/** Convierte issues de zod al shape `errores[]` del contrato (422). */
function erroresDeIssues(issues: z.ZodIssue[]): ErrorCampo[] {
  return issues.map((issue) => ({
    campo: issue.path.join(".") || "body",
    mensaje: issue.message,
  }));
}

/** Valida el cuerpo de la reserva (422 problem+json con `errores[]`). */
export function parsearTurnoCrear(cuerpo: unknown): TurnoCrearInput {
  const resultado = turnoCrearSchema.safeParse(cuerpo);
  if (!resultado.success) {
    throw new ValidationError(erroresDeIssues(resultado.error.issues));
  }
  return resultado.data;
}

/** Valida el cuerpo de reagendar (422 problem+json con `errores[]`). */
export function parsearTurnoReagendar(cuerpo: unknown): TurnoReagendarInput {
  const resultado = turnoReagendarSchema.safeParse(cuerpo);
  if (!resultado.success) {
    throw new ValidationError(erroresDeIssues(resultado.error.issues));
  }
  return resultado.data.slot_key;
}

/** Valida el cuerpo de las acciones de negocio (422 con `errores[]`). */
export function parsearAccionTurno(cuerpo: unknown): {
  accion: AccionTurno;
  motivo: string | null;
} {
  const resultado = accionTurnoSchema.safeParse(cuerpo);
  if (!resultado.success) {
    throw new ValidationError(erroresDeIssues(resultado.error.issues));
  }
  return {
    accion: resultado.data.accion,
    motivo: resultado.data.motivo ?? null,
  };
}