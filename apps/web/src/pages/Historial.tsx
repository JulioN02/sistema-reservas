import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { FormEvent } from "react";
import { usePanel } from "../components/PanelContext";
import type { TurnoResumen } from "../lib/apiClient";
import { apiClient, esNoAutorizado, mensajeDeError } from "../lib/apiClient";
import {
  fechaEnZona,
  finDelDiaUtc,
  formatearHoraLocal,
  inicioDelDiaUtc,
} from "../lib/fechas";

/**
 * Historial del negocio (VNG-02, VNG-S6): GET /turnos con filtros por estado
 * y rango de fechas (interpretados en la zona del negocio), ordenado desc.
 */

const ESTADOS = [
  "pendiente",
  "confirmado",
  "completado",
  "cancelado",
  "no_show",
] as const;

interface Filtros {
  estado: string;
  desde: string;
  hasta: string;
}

const FILTROS_VACIOS: Filtros = { estado: "", desde: "", hasta: "" };

export function Historial() {
  const { zonaHoraria } = usePanel();
  const navigate = useNavigate();
  const [estado, setEstado] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [consulta, setConsulta] = useState<Filtros>(FILTROS_VACIOS);
  const [turnos, setTurnos] = useState<TurnoResumen[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let activo = true;
    setCargando(true);
    apiClient
      .historial({
        estado: consulta.estado === "" ? undefined : consulta.estado,
        desde:
          consulta.desde === ""
            ? undefined
            : inicioDelDiaUtc(consulta.desde, zonaHoraria),
        hasta:
          consulta.hasta === ""
            ? undefined
            : finDelDiaUtc(consulta.hasta, zonaHoraria),
      })
      .then((lista) => {
        if (!activo) return;
        setTurnos(lista);
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
  }, [consulta, zonaHoraria, navigate]);

  function aplicar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    setConsulta({ estado, desde, hasta });
  }

  return (
    <section aria-label="Historial de turnos" className="historial">
      <h3>Historial</h3>

      <form className="historial__filtros" onSubmit={aplicar}>
        <div className="historial__campo">
          <label htmlFor="estado">Estado</label>
          <select
            id="estado"
            value={estado}
            onChange={(evento) => setEstado(evento.target.value)}
          >
            <option value="">Todos</option>
            {ESTADOS.map((valor) => (
              <option key={valor} value={valor}>
                {valor}
              </option>
            ))}
          </select>
        </div>
        <div className="historial__campo">
          <label htmlFor="desde">Desde</label>
          <input
            id="desde"
            type="date"
            value={desde}
            onChange={(evento) => setDesde(evento.target.value)}
          />
        </div>
        <div className="historial__campo">
          <label htmlFor="hasta">Hasta</label>
          <input
            id="hasta"
            type="date"
            value={hasta}
            onChange={(evento) => setHasta(evento.target.value)}
          />
        </div>
        <button type="submit">Filtrar</button>
      </form>

      {error !== null ? <p role="alert">{error}</p> : null}

      {cargando ? (
        <p role="status">Cargando historial…</p>
      ) : turnos.length === 0 ? (
        <p role="status">No hay turnos para los filtros elegidos.</p>
      ) : (
        <table className="historial__tabla">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Hora</th>
              <th>Cliente</th>
              <th>Servicio</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {turnos.map((turno) => (
              <tr key={turno.id}>
                <td>{fechaEnZona(new Date(turno.fecha_hora_inicio), zonaHoraria)}</td>
                <td>{formatearHoraLocal(turno.fecha_hora_inicio, zonaHoraria)}</td>
                <td>{turno.cliente_nombre}</td>
                <td>{turno.servicio_nombre}</td>
                <td>{turno.estado}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
