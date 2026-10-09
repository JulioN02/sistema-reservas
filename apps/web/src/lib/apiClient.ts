import type { components } from "@sistema-reservas/contracts";

/**
 * Cliente de API tipado desde los tipos generados del contrato
 * (packages/contracts openapi.yaml → openapi-typescript).
 *
 * La base URL se configura con VITE_API_URL (por defecto, mismo origen).
 */

export type ServicioPublico = components["schemas"]["ServicioPublico"];
export type AgendaResponse = components["schemas"]["AgendaResponse"];
export type TurnoCreado = components["schemas"]["TurnoCreado"];
export type TurnoGestion = components["schemas"]["TurnoGestion"];
export type ErrorContract = components["schemas"]["Error"];

const BASE_URL = import.meta.env.VITE_API_URL ?? "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly problem: ErrorContract;

  constructor(status: number, problem: ErrorContract) {
    super(problem.detail);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const respuesta = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...init?.headers,
    },
  });

  if (!respuesta.ok) {
    let problem: ErrorContract | undefined;
    try {
      problem = (await respuesta.json()) as ErrorContract;
    } catch {
      problem = undefined;
    }
    throw new ApiError(respuesta.status, problem ?? {
      type: "about:blank",
      title: respuesta.statusText,
      status: respuesta.status,
      detail: `Error ${respuesta.status}: ${respuesta.statusText}`,
    });
  }

  if (respuesta.status === 204) {
    return undefined as T;
  }
  return (await respuesta.json()) as T;
}

export const apiClient = {
  /** GET /api/v1/servicios — servicios activos del flujo público. */
  listarServicios: () => request<ServicioPublico[]>("/servicios"),

  /** GET /api/v1/agenda — slots disponibles (proyección calculada). */
  calcularAgenda: (params: { servicio_id: string; desde: string; hasta: string }) =>
    request<AgendaResponse>(
      `/agenda?servicio_id=${encodeURIComponent(params.servicio_id)}&desde=${params.desde}&hasta=${params.hasta}`,
    ),

  /** POST /api/v1/turnos — crea una reserva (claim atómico). */
  crearTurno: (body: components["schemas"]["TurnoCrearInput"]) =>
    request<TurnoCreado>("/turnos", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** GET /api/v1/turnos/{token} — estado del turno por enlace de gestión. */
  obtenerTurnoPorToken: (token: string) =>
    request<TurnoGestion>(`/turnos/${encodeURIComponent(token)}`),
};