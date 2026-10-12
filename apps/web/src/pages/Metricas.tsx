import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { MetricasResumen } from "../lib/apiClient";
import { apiClient, esNoAutorizado, mensajeDeError } from "../lib/apiClient";
import { formatearPorcentaje } from "../lib/metricas";

/**
 * Métricas del negocio (MTE-02, A9): GET /metricas/resumen → 4 KPIs.
 * Un KPI nulo (sin dato) se muestra como "—", nunca como 0.
 */
export function Metricas() {
  const navigate = useNavigate();
  const [resumen, setResumen] = useState<MetricasResumen | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let activo = true;
    apiClient
      .resumenMetricas()
      .then((datos) => {
        if (!activo) return;
        setResumen(datos);
        setCargando(false);
      })
      .catch((fallo: unknown) => {
        if (!activo) return;
        if (esNoAutorizado(fallo)) {
          navigate("/login");
          return;
        }
        setError(mensajeDeError(fallo));
        setCargando(false);
      });
    return () => {
      activo = false;
    };
  }, [navigate]);

  return (
    <section aria-label="Métricas del negocio" className="metricas">
      <h3>Métricas</h3>

      {error !== null ? <p role="alert">{error}</p> : null}

      {cargando ? (
        <p role="status">Cargando métricas…</p>
      ) : resumen === null ? null : (
        <div className="metricas__tarjetas">
          <article className="metricas__kpi" aria-label="Reservas por semana">
            <h4>Reservas por semana</h4>
            <ul className="metricas__semanas">
              {resumen.reservas_por_semana.map((semana) => (
                <li key={semana.semana}>
                  <span>{semana.semana}</span>: <span>{semana.cantidad}</span>
                </li>
              ))}
            </ul>
          </article>

          <article className="metricas__kpi" aria-label="Tasa de no-show">
            <h4>Tasa de no-show</h4>
            <p className="metricas__valor">
              {formatearPorcentaje(resumen.tasa_no_show)}
            </p>
          </article>

          <article className="metricas__kpi" aria-label="Ocupación de la semana">
            <h4>Ocupación de la semana</h4>
            <p className="metricas__valor">
              {formatearPorcentaje(resumen.ocupacion_semana)}
            </p>
          </article>

          <article className="metricas__kpi" aria-label="Cancelaciones">
            <h4>Cancelaciones</h4>
            <p className="metricas__valor">{resumen.cancelaciones.cantidad}</p>
            <p className="metricas__detalle">
              {formatearPorcentaje(resumen.cancelaciones.tasa)}
            </p>
          </article>
        </div>
      )}
    </section>
  );
}
