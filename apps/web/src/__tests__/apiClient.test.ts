import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient, ApiError, mensajeDeError } from "../lib/apiClient";
import { instalarFetchFalso, respuestaJson } from "./fetchMock";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiClient — acciones del enlace de gestión", () => {
  it("confirmarTurno hace POST al path del contrato", async () => {
    const fetchMock = instalarFetchFalso(() =>
      respuestaJson(200, { turno_id: "turno-1", estado: "confirmado" }),
    );

    const resultado = await apiClient.confirmarTurno("tok-1");

    expect(resultado.estado).toBe("confirmado");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/turnos/tok-1/confirmar",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("cancelarTurno hace POST al path del contrato", async () => {
    const fetchMock = instalarFetchFalso(() =>
      respuestaJson(200, { turno_id: "turno-1", estado: "cancelado" }),
    );

    await apiClient.cancelarTurno("tok-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/turnos/tok-1/cancelar",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reagendarTurno envía el slot_key elegido en el cuerpo", async () => {
    const fetchMock = instalarFetchFalso(() =>
      respuestaJson(200, {
        turno_id: "turno-1",
        estado: "pendiente",
        fecha_hora_inicio: "2026-10-05T10:00:00.000Z",
        fecha_hora_fin: "2026-10-05T10:30:00.000Z",
      }),
    );

    await apiClient.reagendarTurno("tok-1", "2026-10-05T10:00:00.000Z|svc-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/turnos/tok-1/reagendar",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ slot_key: "2026-10-05T10:00:00.000Z|svc-1" }),
      }),
    );
  });

  it("lanza ApiError con el problem+json cuando la respuesta no es ok", async () => {
    instalarFetchFalso(() =>
      respuestaJson(403, {
        type: "about:blank",
        title: "Fuera de gracia",
        status: 403,
        detail: "El turno está fuera del plazo de cancelación.",
      }),
    );

    await expect(apiClient.cancelarTurno("tok-1")).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(apiClient.cancelarTurno("tok-1")).rejects.toThrow(
      /fuera del plazo de cancelación/i,
    );
  });
});

describe("apiClient — helpers puros", () => {
  it("mensajeDeError devuelve el detail del problem+json", () => {
    const error = new ApiError(409, {
      type: "about:blank",
      title: "Slot ocupado",
      status: 409,
      detail: "El slot solicitado ya no está disponible.",
    });
    expect(mensajeDeError(error)).toBe(
      "El slot solicitado ya no está disponible.",
    );
  });
});
