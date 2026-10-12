import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgendaResponse,
  ServicioPublico,
  TurnoGestion,
} from "../lib/apiClient";
import { Gestion } from "../pages/Gestion";
import { instalarFetchFalso, respuestaJson } from "./fetchMock";

const ZONA = "America/Argentina/Buenos_Aires";

const TURNO_GESTION: TurnoGestion = {
  estado: "pendiente",
  servicio: "Corte de cabello",
  fecha_hora_inicio: "2026-10-05T09:00:00.000Z",
  fecha_hora_fin: "2026-10-05T09:30:00.000Z",
  cliente_nombre: "Ana Pérez",
};

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
          slot_key: "2026-10-05T10:00:00.000Z|svc-1",
          fecha_hora_inicio: "2026-10-05T10:00:00.000Z",
          fecha_hora_fin: "2026-10-05T10:30:00.000Z",
        },
      ],
    },
  ],
};

function instalarApi(overrides?: {
  cancelar?: () => ReturnType<typeof respuestaJson>;
}) {
  return instalarFetchFalso((url, init) => {
    if (url === "/api/v1/turnos/tok-1") return respuestaJson(200, TURNO_GESTION);
    if (url === "/api/v1/turnos/tok-1/confirmar" && init?.method === "POST") {
      return respuestaJson(200, { turno_id: "turno-1", estado: "confirmado" });
    }
    if (url === "/api/v1/turnos/tok-1/cancelar" && init?.method === "POST") {
      return (
        overrides?.cancelar?.() ??
        respuestaJson(200, { turno_id: "turno-1", estado: "cancelado" })
      );
    }
    if (url === "/api/v1/turnos/tok-1/reagendar" && init?.method === "POST") {
      return respuestaJson(200, {
        turno_id: "turno-1",
        estado: "pendiente",
        fecha_hora_inicio: "2026-10-05T10:00:00.000Z",
        fecha_hora_fin: "2026-10-05T10:30:00.000Z",
      });
    }
    if (url === "/api/v1/servicios") return respuestaJson(200, SERVICIOS);
    if (url.startsWith("/api/v1/agenda")) return respuestaJson(200, AGENDA);
    return respuestaJson(404, {
      type: "about:blank",
      title: "No encontrado",
      status: 404,
      detail: "no",
    });
  });
}

function renderGestion() {
  return render(
    <MemoryRouter initialEntries={["/g/tok-1"]}>
      <Routes>
        <Route path="/g/:token" element={<Gestion />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Gestion — página del enlace /g/{token}", () => {
  it("muestra estado, servicio, cliente y hora local del negocio", async () => {
    instalarApi();
    renderGestion();

    expect(
      await screen.findByRole("heading", { name: /gestión de turno/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Corte de cabello")).toBeInTheDocument();
    expect(screen.getByText("Ana Pérez")).toBeInTheDocument();
    expect(screen.getByText("pendiente")).toBeInTheDocument();
    // 09:00 UTC → 06:00 en Buenos Aires.
    expect(screen.getByText(/06:00/)).toBeInTheDocument();
  });

  it("confirma el turno y refleja el nuevo estado", async () => {
    const fetchMock = instalarApi();
    renderGestion();

    fireEvent.click(await screen.findByRole("button", { name: "Confirmar" }));

    await waitFor(() =>
      expect(screen.getByText("confirmado")).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/turnos/tok-1/confirmar",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("cancela el turno y refleja el nuevo estado", async () => {
    instalarApi();
    renderGestion();

    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));

    await waitFor(() =>
      expect(screen.getByText("cancelado")).toBeInTheDocument(),
    );
  });

  it("muestra el mensaje del 403 cuando la cancelación está fuera de gracia", async () => {
    instalarApi({
      cancelar: () =>
        respuestaJson(403, {
          type: "about:blank",
          title: "Fuera de gracia",
          status: 403,
          detail: "El turno está fuera del plazo de cancelación. Contacta al negocio.",
        }),
    });
    renderGestion();

    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /fuera del plazo de cancelación/i,
    );
  });

  it("reagenda a un nuevo slot elegido en el selector", async () => {
    const fetchMock = instalarApi();
    renderGestion();

    fireEvent.click(await screen.findByRole("button", { name: "Reagendar" }));
    expect(
      await screen.findByRole("heading", { name: /reagendar turno/i }),
    ).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "07:00" }));
    fireEvent.click(screen.getByRole("button", { name: /confirmar cambio/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/turnos/tok-1/reagendar",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ slot_key: "2026-10-05T10:00:00.000Z|svc-1" }),
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByText(/07:00/)).toBeInTheDocument(),
    );
  });
});
