import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelProvider } from "../components/PanelContext";
import type { TurnoResumen } from "../lib/apiClient";
import { Historial } from "../pages/Historial";
import { instalarFetchFalso, respuestaJson } from "./fetchMock";

const ZONA = "America/Argentina/Buenos_Aires";

const CANCELADO: TurnoResumen = {
  id: "turno-9",
  estado: "cancelado",
  cliente_nombre: "Luis Gómez",
  servicio_nombre: "Color",
  fecha_hora_inicio: "2026-10-02T13:00:00.000Z",
  fecha_hora_fin: "2026-10-02T14:00:00.000Z",
};

function renderHistorial() {
  return render(
    <MemoryRouter>
      <PanelProvider value={{ zonaHoraria: ZONA, operadorNombre: "Op" }}>
        <Historial />
      </PanelProvider>
    </MemoryRouter>,
  );
}

/** Última URL solicitada, como string. */
function ultimaUrl(fetchMock: ReturnType<typeof instalarFetchFalso>): string {
  return String(fetchMock.mock.calls.at(-1)?.[0] ?? "");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Historial — filtros estado/rango (VNG-S6, VNG-02)", () => {
  it("carga el historial y muestra los turnos", async () => {
    instalarFetchFalso((url) => {
      if (url.startsWith("/api/v1/turnos")) return respuestaJson(200, [CANCELADO]);
      return respuestaJson(404, { type: "about:blank", title: "x", status: 404, detail: "no" });
    });
    renderHistorial();

    expect(await screen.findByText("Luis Gómez")).toBeInTheDocument();
    expect(screen.getByText("Color")).toBeInTheDocument();
    const tabla = screen.getByRole("table");
    expect(within(tabla).getByText("cancelado")).toBeInTheDocument();
  });

  it("envía estado y rango en la zona del negocio al filtrar (VNG-S6)", async () => {
    const fetchMock = instalarFetchFalso((url) => {
      if (url.startsWith("/api/v1/turnos")) return respuestaJson(200, [CANCELADO]);
      return respuestaJson(404, { type: "about:blank", title: "x", status: 404, detail: "no" });
    });
    renderHistorial();
    await screen.findByText("Luis Gómez");

    fireEvent.change(screen.getByLabelText(/estado/i), {
      target: { value: "cancelado" },
    });
    fireEvent.change(screen.getByLabelText(/desde/i), {
      target: { value: "2026-10-01" },
    });
    fireEvent.change(screen.getByLabelText(/hasta/i), {
      target: { value: "2026-10-05" },
    });
    fireEvent.click(screen.getByRole("button", { name: /filtrar/i }));

    await vi.waitFor(() => {
      const params = new URL(ultimaUrl(fetchMock), "http://localhost").searchParams;
      expect(params.get("estado")).toBe("cancelado");
      // 00:00 del 1 de octubre en Buenos Aires (UTC-3) = 03:00 UTC.
      expect(params.get("desde")).toBe("2026-10-01T03:00:00.000Z");
      // Límite superior INCLUSIVO: 23:59:59.999 del 5 de octubre en Buenos Aires
      // (no el 00:00 del 6, que sería exclusivo y causaría off-by-one).
      expect(params.get("hasta")).toBe("2026-10-06T02:59:59.999Z");
    });
  });

  it("hasta es inclusivo: envía el último instante del día local, sin off-by-one (VNG-S6)", async () => {
    const fetchMock = instalarFetchFalso((url) => {
      if (url.startsWith("/api/v1/turnos")) return respuestaJson(200, [CANCELADO]);
      return respuestaJson(404, { type: "about:blank", title: "x", status: 404, detail: "no" });
    });
    renderHistorial();
    await screen.findByText("Luis Gómez");

    fireEvent.change(screen.getByLabelText(/hasta/i), {
      target: { value: "2026-10-05" },
    });
    fireEvent.click(screen.getByRole("button", { name: /filtrar/i }));

    await vi.waitFor(() => {
      const params = new URL(ultimaUrl(fetchMock), "http://localhost").searchParams;
      const hasta = params.get("hasta");
      expect(hasta).toBe("2026-10-06T02:59:59.999Z");
      // No debe enviarse la medianoche del día siguiente (límite exclusivo).
      expect(hasta).not.toBe("2026-10-06T03:00:00.000Z");
    });
  });
});
