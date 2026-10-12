import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelProvider } from "../components/PanelContext";
import type { TurnoResumen } from "../lib/apiClient";
import { Dashboard } from "../pages/Dashboard";
import { instalarFetchFalso, respuestaJson } from "./fetchMock";

const ZONA = "America/Argentina/Buenos_Aires";

const TURNO: TurnoResumen = {
  id: "turno-1",
  estado: "confirmado",
  cliente_nombre: "Ana Pérez",
  servicio_nombre: "Corte de cabello",
  fecha_hora_inicio: "2026-10-05T09:00:00.000Z",
  fecha_hora_fin: "2026-10-05T09:30:00.000Z",
};

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={["/panel"]}>
      <Routes>
        <Route path="/login" element={<h2>Iniciar sesión</h2>} />
        <Route
          path="/panel"
          element={
            <PanelProvider value={{ zonaHoraria: ZONA, operadorNombre: "Op" }}>
              <Dashboard />
            </PanelProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dashboard — vista del día (VNG-S3, RB-VNG-01)", () => {
  it("muestra los turnos cronológicos con hora local del negocio", async () => {
    instalarFetchFalso((url) => {
      if (url.startsWith("/api/v1/agenda/dia")) return respuestaJson(200, [TURNO]);
      return respuestaJson(404, { type: "about:blank", title: "x", status: 404, detail: "no" });
    });
    renderDashboard();

    expect(await screen.findByText("Ana Pérez")).toBeInTheDocument();
    expect(screen.getByText("Corte de cabello")).toBeInTheDocument();
    expect(screen.getByText("confirmado")).toBeInTheDocument();
    // 09:00 UTC = 06:00 en Buenos Aires.
    expect(screen.getByText("06:00")).toBeInTheDocument();
  });

  it("recarga la vista al cambiar la fecha (selector)", async () => {
    const fetchMock = instalarFetchFalso((url) => {
      if (url.startsWith("/api/v1/agenda/dia")) return respuestaJson(200, [TURNO]);
      return respuestaJson(404, { type: "about:blank", title: "x", status: 404, detail: "no" });
    });
    renderDashboard();

    await screen.findByText("Ana Pérez");
    fireEvent.change(screen.getByLabelText(/fecha/i), {
      target: { value: "2026-10-06" },
    });

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/agenda/dia?fecha=2026-10-06"),
        expect.anything(),
      ),
    );
  });

  it("redirige a login si la vista del día responde 401 (VNG-S7)", async () => {
    instalarFetchFalso(() =>
      respuestaJson(401, {
        type: "about:blank",
        title: "No autorizado",
        status: 401,
        detail: "Se requiere una sesión válida.",
      }),
    );
    renderDashboard();

    expect(
      await screen.findByRole("heading", { name: "Iniciar sesión" }),
    ).toBeInTheDocument();
  });
});
