import type { TurnoEstado } from "./apiClient";

/**
 * Reglas puras de las acciones del negocio sobre un turno (vista-negocio):
 *
 * - RB-VNG-02 / CA-VNG-02: `no_show` disponible solo desde inicio + 30 min.
 * - RB-VNG-03: `completado` disponible desde el inicio (no antes).
 * - EC-12: los estados terminales no admiten más acciones.
 *
 * Funciones deterministas (reciben `ahora`) para poder testear sin relojes.
 */

/** Acciones del negocio — espejo del enum `accion` del contrato (const types). */
export const AccionTurno = {
  Confirmar: "confirmar",
  Cancelar: "cancelar",
  Completado: "completado",
  NoShow: "no_show",
} as const;
export type AccionTurno = (typeof AccionTurno)[keyof typeof AccionTurno];

const MS_POR_MINUTO = 60_000;
/** Ventana mínima tras el inicio para marcar no_show (RB-VNG-02). */
export const VENTANA_NO_SHOW_MINUTOS = 30;

/** RB-VNG-03: `completado` desde el inicio del turno. */
export function puedeMarcarCompletado(inicioIso: string, ahora: Date): boolean {
  return ahora.getTime() >= new Date(inicioIso).getTime();
}

/** RB-VNG-02 / CA-VNG-02: `no_show` desde inicio + 30 min. */
export function puedeMarcarNoShow(inicioIso: string, ahora: Date): boolean {
  const desde = new Date(inicioIso).getTime() + VENTANA_NO_SHOW_MINUTOS * MS_POR_MINUTO;
  return ahora.getTime() >= desde;
}

/** Estados terminales: sin acciones disponibles (EC-12). */
export function esEstadoTerminal(estado: TurnoEstado): boolean {
  return estado === "completado" || estado === "cancelado" || estado === "no_show";
}
