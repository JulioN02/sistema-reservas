import { describe, expect, it } from "vitest";
import {
  fechaEnZona,
  finDelDiaUtc,
  formatearFechaLarga,
  formatearHoraLocal,
  horaDeSlotKey,
  inicioDelDiaUtc,
  sumarDias,
  ventanaDeReserva,
} from "../lib/fechas";

const ZONA = "America/Argentina/Buenos_Aires";

describe("fechas — utilidades puras (zona del negocio)", () => {
  it("fechaEnZona respeta la fecha local del negocio (no la UTC)", () => {
    // 02:00 UTC del 5 de octubre = 23:00 del 4 de octubre en Buenos Aires.
    expect(fechaEnZona(new Date("2026-10-05T02:00:00.000Z"), ZONA)).toBe(
      "2026-10-04",
    );
    // 12:00 UTC del 5 de octubre sigue siendo el 5 en Buenos Aires.
    expect(fechaEnZona(new Date("2026-10-05T12:00:00.000Z"), ZONA)).toBe(
      "2026-10-05",
    );
  });

  it("sumarDias cruza el fin de mes correctamente", () => {
    expect(sumarDias("2026-10-28", 7)).toBe("2026-11-04");
    expect(sumarDias("2026-10-05", 0)).toBe("2026-10-05");
  });

  it("ventanaDeReserva devuelve 7 días desde hoy (zona del negocio)", () => {
    const rango = ventanaDeReserva(
      new Date("2026-10-05T12:00:00.000Z"),
      ZONA,
      7,
    );
    expect(rango).toEqual({ desde: "2026-10-05", hasta: "2026-10-12" });
  });

  it("formatearHoraLocal presenta el instante en hora del negocio", () => {
    // 09:00 UTC = 06:00 en Buenos Aires (UTC-3).
    expect(formatearHoraLocal("2026-10-05T09:00:00.000Z", ZONA)).toBe("06:00");
  });

  it("formatearFechaLarga escribe el día en español neutro", () => {
    const texto = formatearFechaLarga("2026-10-05");
    expect(texto).toMatch(/lunes/i);
    expect(texto).toMatch(/octubre/i);
    expect(texto).toMatch(/5/);
  });

  it("horaDeSlotKey extrae el inicio y lo presenta en hora local", () => {
    expect(horaDeSlotKey("2026-10-05T09:30:00.000Z|svc-1", ZONA)).toBe("06:30");
  });

  it("inicioDelDiaUtc convierte la medianoche local del negocio a UTC", () => {
    // 00:00 del 5 de octubre en Buenos Aires (UTC-3) = 03:00 UTC.
    expect(inicioDelDiaUtc("2026-10-05", ZONA)).toBe(
      "2026-10-05T03:00:00.000Z",
    );
    // En UTC la medianoche coincide con el inicio del día.
    expect(inicioDelDiaUtc("2026-10-05", "UTC")).toBe(
      "2026-10-05T00:00:00.000Z",
    );
  });

  it("finDelDiaUtc es el último instante del día local (límite inclusivo)", () => {
    // 23:59:59.999 del 5 de octubre en Buenos Aires (UTC-3) = 02:59:59.999 UTC del 6.
    expect(finDelDiaUtc("2026-10-05", ZONA)).toBe("2026-10-06T02:59:59.999Z");
  });
});
