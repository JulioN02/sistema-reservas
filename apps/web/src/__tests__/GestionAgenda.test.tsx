import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelProvider } from "../components/PanelContext";
import type { Horario } from "../lib/apiClient";
import { GestionAgenda } from "../pages/GestionAgenda";
import { instalarFetchFalso, respuestaJson } from "./fetchMock";

const ZONA = "America/Argentina/Buenos_Aires";

const HORARIO: Horario = {
  id: "hor-1",
  dia_semana: 1,
  hora_inicio: "09:00",
  hora_fin: "13:00",
  timezone: ZONA,
  created_at: "2026-10-01T00:00:00.000Z",
};

function renderGestion() {
  return render(
    <MemoryRouter>
      <PanelProvider value={{ zonaHoraria: ZONA, operadorNombre: "Op" }}>
        <GestionAgenda />
      </PanelProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GestionAgenda — CRUD de agenda (RB-AGD-01/03)", () => {
  it("lista horarios y crea uno nuevo (recarga la lista)", async () => {
    let creado = false;
    const fetchMock = instalarFetchFalso((url, init) => {
      if (url === "/api/v1/agenda/horarios" && init?.method === "POST") {
        creado = true;
        return respuestaJson(201, HORARIO);
      }
      if (url === "/api/v1/agenda/horarios") {
        return respuestaJson(200, creado ? [HORARIO, { ...HORARIO, id: "hor-2" }] : [HORARIO]);
      }
      if (url === "/api/v1/agenda/bloques") return respuestaJson(200, []);
      if (url === "/api/v1/servicios") return respuestaJson(200, []);
      return respuestaJson(404, { type: "about:blank", title: "x", status: 404, detail: "no" });
    });
    renderGestion();

    expect(await screen.findByText(/09:00/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/día/i), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/hora de inicio/i), {
      target: { value: "14:00" },
    });
    fireEvent.change(screen.getByLabelText(/hora de fin/i), {
      target: { value: "18:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /crear horario/i }));

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/agenda/horarios",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            dia_semana: 2,
            hora_inicio: "14:00",
            hora_fin: "18:00",
            timezone: ZONA,
          }),
        }),
      ),
    );
    expect(await screen.findByText(/horario creado/i)).toBeInTheDocument();
  });

  it("muestra el conflicto de solape (409)", async () => {
    instalarFetchFalso((url, init) => {
      if (url === "/api/v1/agenda/horarios" && init?.method === "POST") {
        return respuestaJson(409, {
          type: "about:blank",
          title: "Conflicto",
          status: 409,
          detail: "El horario solapa con otro existente del mismo día.",
        });
      }
      if (url === "/api/v1/agenda/horarios") return respuestaJson(200, []);
      if (url === "/api/v1/agenda/bloques") return respuestaJson(200, []);
      if (url === "/api/v1/servicios") return respuestaJson(200, []);
      return respuestaJson(404, { type: "about:blank", title: "x", status: 404, detail: "no" });
    });
    renderGestion();

    fireEvent.change(await screen.findByLabelText(/día/i), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/hora de inicio/i), { target: { value: "14:00" } });
    fireEvent.change(screen.getByLabelText(/hora de fin/i), { target: { value: "18:00" } });
    fireEvent.click(screen.getByRole("button", { name: /crear horario/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/solapa/i);
  });

  it("expone los errores por campo de un 422", async () => {
    instalarFetchFalso((url, init) => {
      if (url === "/api/v1/agenda/horarios" && init?.method === "POST") {
        return respuestaJson(422, {
          type: "about:blank",
          title: "Validación",
          status: 422,
          detail: "Revisa los datos.",
          errores: [{ campo: "hora_fin", mensaje: "Debe ser posterior al inicio." }],
        });
      }
      if (url === "/api/v1/agenda/horarios") return respuestaJson(200, []);
      if (url === "/api/v1/agenda/bloques") return respuestaJson(200, []);
      if (url === "/api/v1/servicios") return respuestaJson(200, []);
      return respuestaJson(404, { type: "about:blank", title: "x", status: 404, detail: "no" });
    });
    renderGestion();

    fireEvent.change(await screen.findByLabelText(/día/i), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/hora de inicio/i), { target: { value: "14:00" } });
    fireEvent.change(screen.getByLabelText(/hora de fin/i), { target: { value: "13:00" } });
    fireEvent.click(screen.getByRole("button", { name: /crear horario/i }));

    expect(await screen.findByText(/hora_fin: debe ser posterior/i)).toBeInTheDocument();
  });
});
