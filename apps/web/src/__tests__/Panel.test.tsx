import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperadorSesion } from "../lib/apiClient";
import { Login } from "../pages/Login";
import { Panel } from "../pages/Panel";
import { instalarFetchFalso, respuestaJson } from "./fetchMock";

const OPERADOR: OperadorSesion = {
  operador_id: "op-1",
  email: "operador@demo.local",
  nombre: "Operador Demo",
  timezone: "America/Argentina/Buenos_Aires",
};

function renderPanel() {
  return render(
    <MemoryRouter initialEntries={["/panel"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/panel" element={<Panel />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Panel — shell del negocio (auth-gated, VNG-S7)", () => {
  it("redirige a login cuando /auth/me responde 401 (VNG-S7)", async () => {
    instalarFetchFalso((url) => {
      if (url === "/api/v1/auth/me") {
        return respuestaJson(401, {
          type: "about:blank",
          title: "No autorizado",
          status: 401,
          detail: "Se requiere una sesión válida.",
        });
      }
      return respuestaJson(404, { type: "about:blank", title: "x", status: 404, detail: "no" });
    });
    renderPanel();

    expect(
      await screen.findByRole("heading", { name: "Iniciar sesión" }),
    ).toBeInTheDocument();
  });

  it("muestra navegación + operador y cierra sesión (RB-VNG-05)", async () => {
    const fetchMock = instalarFetchFalso((url, init) => {
      if (url === "/api/v1/auth/me") return respuestaJson(200, OPERADOR);
      if (url === "/api/v1/auth/logout" && init?.method === "POST") {
        return { ok: true, status: 204, statusText: "", json: async () => ({}) };
      }
      return respuestaJson(404, { type: "about:blank", title: "x", status: 404, detail: "no" });
    });
    renderPanel();

    expect(await screen.findByText("Operador Demo")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Día" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Historial" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Métricas" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agenda" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /cerrar sesión/i }));

    expect(
      await screen.findByRole("heading", { name: "Iniciar sesión" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
