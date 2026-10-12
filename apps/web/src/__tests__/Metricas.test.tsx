import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelProvider } from "../components/PanelContext";
import type { MetricasResumen } from "../lib/apiClient";
import { Metricas } from "../pages/Metricas";
import { instalarFetchFalso, respuestaJson } from "./fetchMock";

const RESUMEN: MetricasResumen = {
  reservas_por_semana: [
    { semana: "2026-W40", cantidad: 12 },
    { semana: "2026-W41", cantidad: 8 },
  ],
  tasa_no_show: 0.125,
  ocupacion_semana: null,
  cancelaciones: { cantidad: 3, tasa: 0.25 },
};

function renderMetricas() {
  return render(
    <MemoryRouter>
      <PanelProvider value={{ zonaHoraria: "UTC", operadorNombre: "Op" }}>
        <Metricas />
      </PanelProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Metricas — 4 KPIs (MTE-02, A9)", () => {
  it("renderiza los KPIs y usa — para los valores nulos", async () => {
    instalarFetchFalso((url) => {
      if (url === "/api/v1/metricas/resumen") return respuestaJson(200, RESUMEN);
      return respuestaJson(404, { type: "about:blank", title: "x", status: 404, detail: "no" });
    });
    renderMetricas();

    // KPI 1 — reservas por semana ISO.
    expect(await screen.findByText(/2026-W40/)).toBeInTheDocument();
    expect(screen.getByText(/2026-W41/)).toBeInTheDocument();
    // KPI 2 — tasa de no-show como porcentaje.
    expect(screen.getByText("12.5 %")).toBeInTheDocument();
    // KPI 3 — ocupación nula → guion.
    expect(screen.getByText("—")).toBeInTheDocument();
    // KPI 4 — cancelaciones cantidad + tasa.
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("25.0 %")).toBeInTheDocument();
  });
});
