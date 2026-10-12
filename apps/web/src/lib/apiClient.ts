import type { components } from "@sistema-reservas/contracts";

/**
 * Cliente de API tipado desde los tipos generados del contrato
 * (packages/contracts openapi.yaml → openapi-typescript).
 *
 * La base URL se configura con VITE_API_URL (por defecto, mismo origen).
 * La sesión del negocio viaja en la cookie `sid`: toda request envía
 * `credentials: "include"` para que la cookie se adjunte también cuando
 * VITE_API_URL apunta a un origen distinto (dev proxy).
 */

export type ServicioPublico = components["schemas"]["ServicioPublico"];
export type Slot = components["schemas"]["Slot"];
export type DiaAgenda = components["schemas"]["DiaAgenda"];
export type AgendaResponse = components["schemas"]["AgendaResponse"];
export type TurnoCreado = components["schemas"]["TurnoCreado"];
export type TurnoGestion = components["schemas"]["TurnoGestion"];
export type TurnoAccionResultado = components["schemas"]["TurnoAccionResultado"];
export type ErrorContract = components["schemas"]["Error"];
export type ErrorCampo = components["schemas"]["ErrorCampo"];

// Panel del negocio (auth-gated).
export type OperadorSesion = components["schemas"]["OperadorSesion"];
export type CredencialesLogin = components["schemas"]["CredencialesLogin"];
export type TurnoEstado = components["schemas"]["TurnoEstado"];
export type TurnoResumen = components["schemas"]["TurnoResumen"];
export type AccionTurnoInput = components["schemas"]["AccionTurnoInput"];
export type MetricasResumen = components["schemas"]["MetricasResumen"];
export type Horario = components["schemas"]["Horario"];
export type HorarioInput = components["schemas"]["HorarioInput"];
export type Bloque = components["schemas"]["Bloque"];
export type BloqueInput = components["schemas"]["BloqueInput"];
export type Servicio = components["schemas"]["Servicio"];
export type ServicioInput = components["schemas"]["ServicioInput"];
export type ServicioParametrosInput =
  components["schemas"]["ServicioParametrosInput"];

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
    credentials: "include",
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

/** Construye una query string omitiendo los parámetros vacíos/indefinidos. */
function query(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [clave, valor] of Object.entries(params)) {
    if (valor !== undefined && valor !== "") usp.set(clave, valor);
  }
  const texto = usp.toString();
  return texto === "" ? "" : `?${texto}`;
}

export const apiClient = {
  /** GET /api/v1/servicios — servicios activos del flujo público. */
  listarServicios: () => request<ServicioPublico[]>("/servicios"),

  /** GET /api/v1/agenda — slots disponibles (proyección calculada). */
  calcularAgenda: (params: { servicio_id: string; desde: string; hasta: string }) =>
    request<AgendaResponse>(
      `/agenda${query({
        servicio_id: params.servicio_id,
        desde: params.desde,
        hasta: params.hasta,
      })}`,
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

  /** POST /api/v1/turnos/{token}/confirmar — confirmación idempotente. */
  confirmarTurno: (token: string) =>
    request<TurnoAccionResultado>(
      `/turnos/${encodeURIComponent(token)}/confirmar`,
      { method: "POST" },
    ),

  /** POST /api/v1/turnos/{token}/cancelar — cancelación dentro de gracia. */
  cancelarTurno: (token: string) =>
    request<TurnoAccionResultado>(
      `/turnos/${encodeURIComponent(token)}/cancelar`,
      { method: "POST" },
    ),

  /** POST /api/v1/turnos/{token}/reagendar — cambio atómico a un nuevo slot. */
  reagendarTurno: (token: string, slotKey: string) =>
    request<TurnoAccionResultado>(
      `/turnos/${encodeURIComponent(token)}/reagendar`,
      { method: "POST", body: JSON.stringify({ slot_key: slotKey }) },
    ),

  // ---------------------------------------------------------------------------
  // Auth del negocio (T-17) — sesión opaca en cookie `sid` (RB-VNG-05).
  // ---------------------------------------------------------------------------

  /** POST /api/v1/auth/login — 200 OperadorSesion + cookie `sid`. */
  login: (credenciales: CredencialesLogin) =>
    request<OperadorSesion>("/auth/login", {
      method: "POST",
      body: JSON.stringify(credenciales),
    }),

  /** POST /api/v1/auth/logout — 204 revoca la sesión. */
  logout: () => request<void>("/auth/logout", { method: "POST" }),

  /** GET /api/v1/auth/me — operador de la sesión activa (incl. timezone). */
  operadorActual: () => request<OperadorSesion>("/auth/me"),

  // ---------------------------------------------------------------------------
  // Vista del negocio (T-17) — día, historial, acciones y métricas.
  // ---------------------------------------------------------------------------

  /** GET /api/v1/agenda/dia?fecha= — turnos del día cronológicos (RB-VNG-01). */
  agendaDelDia: (fecha: string) =>
    request<TurnoResumen[]>(`/agenda/dia${query({ fecha })}`),

  /** GET /api/v1/turnos — historial filtrable por estado y rango (VNG-S6). */
  historial: (filtros: { estado?: string; desde?: string; hasta?: string } = {}) =>
    request<TurnoResumen[]>(
      `/turnos${query({
        estado: filtros.estado,
        desde: filtros.desde,
        hasta: filtros.hasta,
      })}`,
    ),

  /** POST /api/v1/turnos/{id}/acciones — confirmar/cancelar/completado/no_show. */
  accionTurno: (id: string, accion: AccionTurnoInput) =>
    request<TurnoAccionResultado>(
      `/turnos/${encodeURIComponent(id)}/acciones`,
      { method: "POST", body: JSON.stringify(accion) },
    ),

  /** GET /api/v1/metricas/resumen — 4 KPIs (valores nulos posibles). */
  resumenMetricas: () => request<MetricasResumen>("/metricas/resumen"),

  // ---------------------------------------------------------------------------
  // Gestión de agenda del negocio (T-17).
  // ---------------------------------------------------------------------------

  listarHorarios: () => request<Horario[]>("/agenda/horarios"),
  crearHorario: (input: HorarioInput) =>
    request<Horario>("/agenda/horarios", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  actualizarHorario: (id: string, input: HorarioInput) =>
    request<Horario>(`/agenda/horarios/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  eliminarHorario: (id: string) =>
    request<void>(`/agenda/horarios/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  listarBloques: () => request<Bloque[]>("/agenda/bloques"),
  crearBloque: (input: BloqueInput) =>
    request<Bloque>("/agenda/bloques", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  eliminarBloque: (id: string) =>
    request<void>(`/agenda/bloques/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  crearServicio: (input: ServicioInput) =>
    request<Servicio>("/servicios", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  actualizarServicio: (id: string, input: ServicioInput) =>
    request<Servicio>(`/servicios/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  eliminarServicio: (id: string) =>
    request<void>(`/servicios/${encodeURIComponent(id)}`, { method: "DELETE" }),
  actualizarParametrosServicio: (id: string, input: ServicioParametrosInput) =>
    request<Servicio>(`/servicios/${encodeURIComponent(id)}/parametros`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
};

/**
 * Mensaje legible de un error de la API (problem+json `detail`) o genérico
 * si no es un `ApiError`. Nunca expone internals.
 */
export function mensajeDeError(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail;
  return "Ocurrió un error inesperado. Intenta nuevamente.";
}

/**
 * `true` cuando el error es un 401: la sesión es ausente, inválida o expiró
 * (VNG-S7). El panel usa esto para redirigir a /login en cualquier llamada.
 */
export function esNoAutorizado(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** Errores por campo de un 422 (`problem.errores[]`), o `[]` si no aplica. */
export function erroresDeCampo(error: unknown): ErrorCampo[] {
  if (error instanceof ApiError) return error.problem.errores ?? [];
  return [];
}
