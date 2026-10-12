import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormularioContacto } from "../components/FormularioContacto";
import type { TurnoCreado } from "../lib/apiClient";
import { instalarFetchFalso, respuestaJson } from "./fetchMock";

const ZONA = "America/Argentina/Buenos_Aires";
const SERVICIO_ID = "svc-1";
const SLOT_KEY = "2026-10-05T09:00:00.000Z|svc-1";

const TURNO_CREADO: TurnoCreado = {
  turno_id: "turno-1",
  estado: "pendiente",
  enlace_gestion: "/g/token-abc",
  cliente_id: "cli-1",
};

function renderFormulario(overrides?: {
  onCreado?: (t: TurnoCreado) => void;
  onSeleccionarAlternativa?: (slotKey: string) => void;
}) {
  const onCreado = overrides?.onCreado ?? vi.fn();
  const onSeleccionarAlternativa = overrides?.onSeleccionarAlternativa ?? vi.fn();
  render(
    <FormularioContacto
      servicioId={SERVICIO_ID}
      slotKey={SLOT_KEY}
      zonaHoraria={ZONA}
      onCreado={onCreado}
      onVolver={vi.fn()}
      onSeleccionarAlternativa={onSeleccionarAlternativa}
    />,
  );
  return { onCreado, onSeleccionarAlternativa };
}

function completarYEnviar() {
  fireEvent.change(screen.getByLabelText("Nombre"), {
    target: { value: "Ana Pérez" },
  });
  fireEvent.change(screen.getByLabelText(/email/i), {
    target: { value: "ana@example.com" },
  });
  fireEvent.click(screen.getByLabelText(/consentimiento/i));
  fireEvent.click(screen.getByRole("button", { name: /confirmar reserva/i }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FormularioContacto — validación UX y consentimiento", () => {
  it("exige el nombre antes de enviar (no llama a la API)", async () => {
    const fetchMock = instalarFetchFalso(() =>
      respuestaJson(201, TURNO_CREADO),
    );
    renderFormulario();

    fireEvent.click(screen.getByRole("button", { name: /confirmar reserva/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /ingresa tu nombre/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exige al menos un canal de contacto (email o teléfono)", async () => {
    const fetchMock = instalarFetchFalso(() =>
      respuestaJson(201, TURNO_CREADO),
    );
    renderFormulario();

    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Ana Pérez" },
    });
    fireEvent.click(screen.getByLabelText(/consentimiento/i));
    fireEvent.click(screen.getByRole("button", { name: /confirmar reserva/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /email o un teléfono/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exige el consentimiento explícito (PRV-01)", async () => {
    const fetchMock = instalarFetchFalso(() =>
      respuestaJson(201, TURNO_CREADO),
    );
    renderFormulario();

    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Ana Pérez" },
    });
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "ana@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirmar reserva/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /consentimiento/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("crea la reserva y entrega el turno al padre cuando todo es válido", async () => {
    const fetchMock = instalarFetchFalso(() =>
      respuestaJson(201, TURNO_CREADO),
    );
    const { onCreado } = renderFormulario();

    completarYEnviar();

    await waitFor(() => expect(onCreado).toHaveBeenCalledWith(TURNO_CREADO));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/turnos",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("expone las alternativas del 409 para elegir otro horario", async () => {
    instalarFetchFalso(() =>
      respuestaJson(409, {
        type: "about:blank",
        title: "Slot ocupado",
        status: 409,
        detail: "El slot solicitado ya no está disponible.",
        alternativas: ["2026-10-05T09:30:00.000Z|svc-1"],
      }),
    );
    const { onSeleccionarAlternativa } = renderFormulario();

    completarYEnviar();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /ya no está disponible/i,
    );
    const alternativa = await screen.findByRole("button", { name: "06:30" });
    fireEvent.click(alternativa);
    expect(onSeleccionarAlternativa).toHaveBeenCalledWith(
      "2026-10-05T09:30:00.000Z|svc-1",
    );
  });
});
