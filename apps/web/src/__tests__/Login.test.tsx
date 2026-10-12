import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperadorSesion } from "../lib/apiClient";
import { Login } from "../pages/Login";
import { instalarFetchFalso, respuestaJson } from "./fetchMock";

const OPERADOR: OperadorSesion = {
  operador_id: "op-1",
  email: "operador@demo.local",
  nombre: "Operador Demo",
  timezone: "America/Argentina/Buenos_Aires",
};

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/panel" element={<h2>Panel del negocio</h2>} />
      </Routes>
    </MemoryRouter>,
  );
}

function enviar(email = "operador@demo.local", password = "demo-password-123") {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/contraseña/i), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole("button", { name: /ingresar/i }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Login — acceso del operador (VNG-04, VNG-S1/S2)", () => {
  it("inicia sesión y redirige al panel (VNG-S1)", async () => {
    instalarFetchFalso((url, init) => {
      if (url === "/api/v1/auth/login" && init?.method === "POST") {
        return respuestaJson(200, OPERADOR);
      }
      return respuestaJson(404, { type: "about:blank", title: "x", status: 404, detail: "no" });
    });
    renderLogin();

    enviar();

    expect(
      await screen.findByRole("heading", { name: "Panel del negocio" }),
    ).toBeInTheDocument();
  });

  it("muestra el mensaje de credenciales inválidas (401)", async () => {
    instalarFetchFalso(() =>
      respuestaJson(401, {
        type: "about:blank",
        title: "No autorizado",
        status: 401,
        detail: "Credenciales inválidas.",
      }),
    );
    renderLogin();

    enviar("operador@demo.local", "password-mala");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /credenciales inválidas/i,
    );
  });

  it("muestra el bloqueo por demasiados intentos (429)", async () => {
    instalarFetchFalso(() =>
      respuestaJson(429, {
        type: "about:blank",
        title: "Demasiadas peticiones",
        status: 429,
        detail: "Demasiados intentos fallidos. Reintente en 15 minutos.",
      }),
    );
    renderLogin();

    enviar();

    expect(await screen.findByRole("alert")).toHaveTextContent(/15 minutos/i);
  });

  it("expone los errores por campo de un 422", async () => {
    instalarFetchFalso(() =>
      respuestaJson(422, {
        type: "about:blank",
        title: "Validación",
        status: 422,
        detail: "Revisa los datos.",
        errores: [
          { campo: "email", mensaje: "El email no tiene un formato válido." },
          { campo: "password", mensaje: "El password debe tener al menos 8 caracteres." },
        ],
      }),
    );
    renderLogin();

    enviar("valido@example.com", "12345678");

    expect(await screen.findByRole("alert")).toHaveTextContent(/revisa los datos/i);
    expect(screen.getByText(/email: el email no tiene/i)).toBeInTheDocument();
    expect(screen.getByText(/password: el password/i)).toBeInTheDocument();
  });
});
