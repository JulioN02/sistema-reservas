/**
 * Presentación de los KPIs de métricas (A9).
 *
 * El backend devuelve tasas como fracción 0..1 o `null` cuando no hay dato
 * (p. ej. ocupación sin horarios). `null` se muestra como "—", nunca como 0.
 */

/** Fracción 0..1 → porcentaje con un decimal; `null`/`undefined` → "—". */
export function formatearPorcentaje(valor: number | null | undefined): string {
  if (valor === null || valor === undefined) return "—";
  return `${(valor * 100).toFixed(1)} %`;
}
