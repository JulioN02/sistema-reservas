import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgendaResponse, ServicioPublico, TurnoCreado } from "../lib/apiClient";
import { Reservar } from "../pages/Reservar";
import { instalarFetchFalso, respuestaJson } from "./fetchMock";

const ZONA = "America/Argentina/Buenos_Aires";

const SERVICIOS: ServicioPublico[] = [
  {
    id: "svc-1",
    nombre: "Corte de cabello",
    duracion_min: 30,
    precio: null,
    zona_horaria: ZONA,
  },
];

const AGENDA: AgendaResponse = {
  zona_horaria: ZONA,
  dias: [
    {
      fecha: "2026-10-05",
      slots: [
        {
          slot_key: "2026-10-05T09:00:00.000Z|svc-1",
          fecha_hora_inicio: "2026-10-05T09:00:00.000Z",
          fecha_hora_fin: "2026-10-05T09:30:00.000Z",
        },
      ],
    },
  ],
};

const TURNO_CREADO: TurnoCreado = {
  turno_id: "turno-1",
  estado: "pendiente",
  enlace_gestion: "/g/token-abc",
  cliente_id: "cli-1",
};

function instalarApi(overrides?: {
  crearTurno?: () => ReturnType<typeof respuestaJson>;
}) {
  return instalarFetchFalso((url, init) => {
    if (url === "/api/v1/servicios") return respuestaJson(200, SERVICIOS);
    if (url.startsWith("/api/v1/agenda")) return respuestaJson(200, AGENDA);
    if (url === "/api/v1/turnos" && init?.method === "POST") {
      return overrides?.crearTurno?.() ?? respuestaJson(201, TURNO_CREADO);
    }
    return respuestaJson(404, {
      type: "about:blank",
      title: "No encontrado",
      status: 404,
      detail: "no",
    });
  });
}

function renderReservar() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Reservar />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Reservar — flujo público de reserva (≤3 pasos, RNF-05)", () => {
  it("recorre servicio → horario → datos y muestra el enlace de gestión", async () => {
    const fetchMock = instalarApi();
    renderReservar();

    // Paso 1: servicios.
    expect(
      await screen.findByRole("heading", { name: "Elige un servicio" }),
    ).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: /corte de cabello/i }),
    );

    // Paso 2: horarios.
    expect(
      await screen.findByRole("heading", { name: "Elige un horario" }),
    ).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "06:00" }));

    // Paso 3: datos.
    expect(
      await screen.findByRole("heading", { name: "Tus datos" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Ana Pérez" },
    });
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "ana@example.com" },
    });
    fireEvent.click(screen.getByLabelText(/consentimiento/i));
    fireEvent.click(screen.getByRole("button", { name: /confirmar reserva/i }));

    // Éxito: enlace de gestión absoluto desde el origen de la app.
    expect(
      await screen.findByRole("heading", { name: "Reserva confirmada" }),
    ).toBeInTheDocument();
    const enlace = screen.getByRole("link", { name: /gestion/i });
    expect(enlace).toHaveAttribute(
      "href",
      `${window.location.origin}/g/token-abc`,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/agenda?servicio_id=svc-1"),
      expect.anything(),
    );
  });

  it("permite volver del paso de horario al de servicio", async () => {
    instalarApi();
    renderReservar();

    fireEvent.click(
      await screen.findByRole("button", { name: /corte de cabello/i }),
    );
    await screen.findByRole("heading", { name: "Elige un horario" });

    fireEvent.click(screen.getByRole("button", { name: /volver/i }));

    expect(
      await screen.findByRole("heading", { name: "Elige un servicio" }),
    ).toBeInTheDocument();
  });

  it("expone las alternativas cuando el slot ya está ocupado (409)", async () => {
    instalarApi({
      crearTurno: () =>
        respuestaJson(409, {
          type: "about:blank",
          title: "Slot ocupado",
          status: 409,
          detail: "El slot solicitado ya no está disponible.",
          alternativas: ["2026-10-05T09:30:00.000Z|svc-1"],
        }),
    });
    renderReservar();

    fireEvent.click(
      await screen.findByRole("button", { name: /corte de cabello/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "06:00" }));
    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Ana Pérez" },
    });
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "ana@example.com" },
    });
    fireEvent.click(screen.getByLabelText(/consentimiento/i));
    fireEvent.click(screen.getByRole("button", { name: /confirmar reserva/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/ya no está disponible/i),
    );
    expect(
      await screen.findByRole("button", { name: "06:30" }),
    ).toBeInTheDocument();
  });
});
