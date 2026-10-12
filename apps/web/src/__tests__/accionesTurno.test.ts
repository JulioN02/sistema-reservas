import { describe, expect, it } from "vitest";
import {
  AccionTurno,
  esEstadoTerminal,
  puedeMarcarCompletado,
  puedeMarcarNoShow,
} from "../lib/accionesTurno";

/**
 * Ventanas de acción del negocio (capability vista-negocio):
 * - RB-VNG-02 / CA-VNG-02: no_show solo desde inicio + 30 min.
 * - RB-VNG-03: completado desde el inicio (no antes).
 * - EC-12: los estados terminales no admiten más acciones.
 */

describe("accionesTurno — ventanas de acción (RB-VNG-02/03, CA-VNG-02)", () => {
  const ahora = new Date("2026-10-05T12:00:00.000Z");

  it("no_show NO está disponible antes de inicio + 30 min (CA-VNG-02)", () => {
    // El turno empieza en 10 min → todavía no pasaron 30 min desde el inicio.
    expect(puedeMarcarNoShow("2026-10-05T12:10:00.000Z", ahora)).toBe(false);
    // Frontera: 29 min tras el inicio → todavía no.
    expect(puedeMarcarNoShow("2026-10-05T11:31:00.000Z", ahora)).toBe(false);
  });

  it("no_show está disponible desde inicio + 30 min (VNG-S5)", () => {
    // Exactamente en la frontera de 30 min.
    expect(puedeMarcarNoShow("2026-10-05T11:30:00.000Z", ahora)).toBe(true);
    // Turno iniciado hace 35 min.
    expect(puedeMarcarNoShow("2026-10-05T11:25:00.000Z", ahora)).toBe(true);
  });

  it("completado está disponible desde el inicio, no antes (RB-VNG-03)", () => {
    expect(puedeMarcarCompletado("2026-10-05T12:00:00.000Z", ahora)).toBe(true);
    expect(puedeMarcarCompletado("2026-10-05T12:01:00.000Z", ahora)).toBe(false);
  });

  it("reconoce los estados terminales (EC-12)", () => {
    expect(esEstadoTerminal("completado")).toBe(true);
    expect(esEstadoTerminal("cancelado")).toBe(true);
    expect(esEstadoTerminal("no_show")).toBe(true);
    expect(esEstadoTerminal("pendiente")).toBe(false);
    expect(esEstadoTerminal("confirmado")).toBe(false);
  });

  it("las acciones usan el enum del contrato (patrón const types)", () => {
    expect(AccionTurno.Confirmar).toBe("confirmar");
    expect(AccionTurno.Cancelar).toBe("cancelar");
    expect(AccionTurno.Completado).toBe("completado");
    expect(AccionTurno.NoShow).toBe("no_show");
  });
});
