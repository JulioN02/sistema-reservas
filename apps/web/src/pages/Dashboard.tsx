import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { AccionesTurno } from "../components/AccionesTurno";
import { usePanel } from "../components/PanelContext";
import type { TurnoResumen } from "../lib/apiClient";
import { apiClient, esNoAutorizado, mensajeDeError } from "../lib/apiClient";
import { fechaEnZona, formatearFechaLarga, formatearHoraLocal } from "../lib/fechas";

/**
 * Vista del día (VNG-S3, RB-VNG-01): GET /agenda/dia?fecha= con la fecha
 * "hoy" en la zona del negocio. Lista cronológica con hora local, cliente,
 * servicio y estado, más las acciones del negocio por turno (VNG-03).
 */

export function Dashboard() {
  const { zonaHoraria } = usePanel();
  const navigate = useNavigate();
  const [fecha, setFecha] = useState(() => fechaEnZona(new Date(), zonaHoraria));
  const [turnos, setTurnos] = useState<TurnoResumen[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let activo = true;
    setCargando(true);
    apiClient
      .agendaDelDia(fecha)
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
  }, [fecha, recarga, navigate]);

  return (
    <section aria-label="Vista del día" className="dashboard">
      <h3>Vista del día</h3>

      <div className="dashboard__selector">
        <label htmlFor="fecha">Fecha</label>
        <input
          id="fecha"
          type="date"
          value={fecha}
          onChange={(evento) => setFecha(evento.target.value)}
        />
        <span className="dashboard__fecha-larga">{formatearFechaLarga(fecha)}</span>
      </div>

      {error !== null ? <p role="alert">{error}</p> : null}

      {cargando ? (
        <p role="status">Cargando turnos…</p>
      ) : turnos.length === 0 ? (
        <p role="status">No hay turnos para este día.</p>
      ) : (
        <ol className="dashboard__turnos">
          {turnos.map((turno) => (
            <li key={turno.id} className="dashboard__turno">
              <div className="dashboard__datos">
                <span className="dashboard__hora">
                  {formatearHoraLocal(turno.fecha_hora_inicio, zonaHoraria)}
                </span>
                <span className="dashboard__cliente">{turno.cliente_nombre}</span>
                <span className="dashboard__servicio">{turno.servicio_nombre}</span>
                <span className="dashboard__estado">{turno.estado}</span>
              </div>
              <AccionesTurno
                turno={turno}
                onAccion={() => setRecarga((n) => n + 1)}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
