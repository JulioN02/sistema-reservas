import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccionesTurno } from "../components/AccionesTurno";
import { PanelProvider } from "../components/PanelContext";
import type { TurnoResumen } from "../lib/apiClient";
import { instalarFetchFalso, respuestaJson } from "./fetchMock";

const ZONA = "America/Argentina/Buenos_Aires";

/** Turno cuyo inicio está `minutosDesdeAhora` respecto de "ahora". */
function turnoEn(minutosDesdeAhora: number): TurnoResumen {
  const inicio = new Date(Date.now() + minutosDesdeAhora * 60_000);
  return {
    id: "turno-1",
    estado: "confirmado",
    cliente_nombre: "Ana Pérez",
    servicio_nombre: "Corte de cabello",
    fecha_hora_inicio: inicio.toISOString(),
    fecha_hora_fin: new Date(inicio.getTime() + 30 * 60_000).toISOString(),
  };
}

function renderAcciones(turno: TurnoResumen, onAccion = vi.fn()) {
  render(
    <MemoryRouter>
      <PanelProvider value={{ zonaHoraria: ZONA, operadorNombre: "Op" }}>
        <AccionesTurno turno={turno} onAccion={onAccion} />
      </PanelProvider>
    </MemoryRouter>,
  );
  return onAccion;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccionesTurno — acciones del negocio (VNG-03)", () => {
  it("deshabilita No-show antes de inicio + 30 min (CA-VNG-02)", () => {
    renderAcciones(turnoEn(10));

    expect(screen.getByRole("button", { name: "No-show" })).toBeDisabled();
    // El turno aún no empezó: completado tampoco está disponible (RB-VNG-03).
    expect(screen.getByRole("button", { name: "Completado" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeEnabled();
  });

  it("habilita No-show desde inicio + 30 min (VNG-S5)", () => {
    renderAcciones(turnoEn(-35));

    expect(screen.getByRole("button", { name: "No-show" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Completado" })).toBeEnabled();
  });

  it("exige el motivo antes de cancelar (CA-CRG-04): no llama a la API", () => {
    const fetchMock = instalarFetchFalso(() =>
      respuestaJson(200, { turno_id: "turno-1", estado: "cancelado" }),
    );
    renderAcciones(turnoEn(-35));

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getByRole("button", { name: /confirmar cancelación/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/motivo es obligatorio/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancela con motivo y notifica el éxito", async () => {
    const fetchMock = instalarFetchFalso(() =>
      respuestaJson(200, { turno_id: "turno-1", estado: "cancelado" }),
    );
    const onAccion = renderAcciones(turnoEn(-35));

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    const motivo = screen.getByLabelText(/motivo de cancelación/i);
    fireEvent.change(motivo, { target: { value: "El cliente avisó" } });
    fireEvent.click(screen.getByRole("button", { name: /confirmar cancelación/i }));

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/turnos/turno-1/acciones",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ accion: "cancelar", motivo: "El cliente avisó" }),
        }),
      ),
    );
    await vi.waitFor(() => expect(onAccion).toHaveBeenCalled());
  });

  it("no ofrece acciones en estados terminales (EC-12)", () => {
    renderAcciones({ ...turnoEn(-35), estado: "cancelado" });

    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
    expect(screen.getByText(/sin acciones/i)).toBeInTheDocument();
  });
});
