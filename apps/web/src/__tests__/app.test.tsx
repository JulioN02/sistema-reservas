import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { TurnoGestion } from "../lib/apiClient";
import { instalarFetchFalso, respuestaJson } from "./fetchMock";

const TURNO_GESTION: TurnoGestion = {
  estado: "pendiente",
  servicio: "Corte de cabello",
  servicio_id: "svc-1",
  zona_horaria: "America/Argentina/Buenos_Aires",
  fecha_hora_inicio: "2026-10-05T09:00:00.000Z",
  fecha_hora_fin: "2026-10-05T09:30:00.000Z",
  cliente_nombre: "Ana Pérez",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App — rutas públicas", () => {
  it("renderiza la cabecera, la navegación y el flujo de reserva en /", async () => {
    instalarFetchFalso((url) => {
      if (url === "/api/v1/servicios") return respuestaJson(200, []);
      return respuestaJson(404, {
        type: "about:blank",
        title: "No encontrado",
        status: 404,
        detail: "no",
      });
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "Reservar turno" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reservar" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Panel del negocio" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Elige un servicio" }),
    ).toBeInTheDocument();
  });

  it("navega a /g/:token y muestra la gestión del turno", async () => {
    instalarFetchFalso((url) => {
      if (url === "/api/v1/turnos/tok-1") return respuestaJson(200, TURNO_GESTION);
      if (url === "/api/v1/servicios") return respuestaJson(200, []);
      return respuestaJson(404, {
        type: "about:blank",
        title: "No encontrado",
        status: 404,
        detail: "no",
      });
    });

    render(
      <MemoryRouter initialEntries={["/g/tok-1"]}>
        <App />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "Gestión de turno" }),
    ).toBeInTheDocument();
  });
});
