import { describe, expect, it } from "vitest";
import { formatearPorcentaje } from "../lib/metricas";

/** KPIs: una fracción 0..1 se presenta como porcentaje; sin dato → "—". */
describe("metricas — presentación de KPIs (A9)", () => {
  it("formatea una fracción como porcentaje con un decimal", () => {
    expect(formatearPorcentaje(0.125)).toBe("12.5 %");
    expect(formatearPorcentaje(0)).toBe("0.0 %");
    expect(formatearPorcentaje(1)).toBe("100.0 %");
  });

  it("muestra un guion cuando el KPI es nulo (sin dato)", () => {
    expect(formatearPorcentaje(null)).toBe("—");
  });
});
