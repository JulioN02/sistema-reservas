import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "../App";

describe("App — layout base", () => {
  it("renderiza la cabecera, la navegación y el contenido", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "Sistema de Reservas" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Reservar" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Panel del negocio" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });

  it("navega a /reservar y muestra el placeholder del flujo", () => {
    render(
      <MemoryRouter initialEntries={["/reservar"]}>
        <App />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "Reservar turno" }),
    ).toBeInTheDocument();
  });
});