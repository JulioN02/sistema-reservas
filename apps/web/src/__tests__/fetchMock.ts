import { vi } from "vitest";
import type { Mock } from "vitest";

/**
 * Utilidad mínima de mocking de `fetch` para los tests de la SPA.
 *
 * Devuelve un objeto compatible con lo que consume `apiClient`
 * (`ok` / `status` / `statusText` / `json`) sin depender del `Response`
 * global del entorno jsdom.
 */

export interface RespuestaFalsa {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

export function respuestaJson(status: number, body: unknown): RespuestaFalsa {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  };
}

export type ManejadorFetch = (
  url: string,
  init?: RequestInit,
) => RespuestaFalsa;

/** Instala un `fetch` falso global; devuelve el mock para inspección. */
export function instalarFetchFalso(manejador: ManejadorFetch): Mock {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    manejador(String(input), init),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}
