import { useState } from "react";
import { useNavigate } from "react-router";
import type { TurnoResumen } from "../lib/apiClient";
import { apiClient, esNoAutorizado, mensajeDeError } from "../lib/apiClient";
import {
  AccionTurno as Accion,
  esEstadoTerminal,
  puedeMarcarCompletado,
  puedeMarcarNoShow,
} from "../lib/accionesTurno";

/**
 * Acciones del negocio sobre un turno (VNG-03):
 * confirmar · cancelar (motivo obligatorio en UI — RB-VNG-04/CA-CRG-04) ·
 * completado (desde el inicio — RB-VNG-03) · no-show (desde inicio + 30 min —
 * RB-VNG-02/CA-VNG-02). En estados terminales no ofrece acciones (EC-12).
 *
 * Tras una acción exitosa invoca `onAccion` para que la vista se refresque.
 */

export interface AccionesTurnoProps {
  turno: TurnoResumen;
  /** Se invoca tras una acción exitosa para refrescar la lista. */
  onAccion: () => void;
}

export function AccionesTurno({ turno, onAccion }: AccionesTurnoProps) {
  const navigate = useNavigate();
  const [pendiente, setPendiente] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelando, setCancelando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [errorMotivo, setErrorMotivo] = useState<string | null>(null);

  const ahora = new Date();
  const terminal = esEstadoTerminal(turno.estado);

  async function ejecutar(accion: Accion, motivoAccion: string | null) {
    setPendiente(true);
    setError(null);
    try {
      await apiClient.accionTurno(turno.id, { accion, motivo: motivoAccion });
      onAccion();
    } catch (fallo: unknown) {
      if (esNoAutorizado(fallo)) {
        navigate("/login");
        return;
      }
      setError(mensajeDeError(fallo));
    } finally {
      setPendiente(false);
    }
  }

  function confirmarCancelacion() {
    const texto = motivo.trim();
    if (texto === "") {
      setErrorMotivo("El motivo es obligatorio para cancelar.");
      return;
    }
    setErrorMotivo(null);
    void ejecutar(Accion.Cancelar, texto);
  }

  if (terminal) {
    return (
      <p className="acciones-turno__terminal">Sin acciones: {turno.estado}.</p>
    );
  }

  return (
    <div className="acciones-turno">
      {error !== null ? (
        <p role="alert" className="acciones-turno__error">
          {error}
        </p>
      ) : null}

      <div className="acciones-turno__botones">
        <button
          type="button"
          disabled={pendiente}
          onClick={() => void ejecutar(Accion.Confirmar, null)}
        >
          Confirmar
        </button>
        <button
          type="button"
          disabled={pendiente}
          onClick={() => {
            setCancelando(true);
            setErrorMotivo(null);
          }}
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={pendiente || !puedeMarcarCompletado(turno.fecha_hora_inicio, ahora)}
          onClick={() => void ejecutar(Accion.Completado, null)}
        >
          Completado
        </button>
        <button
          type="button"
          disabled={pendiente || !puedeMarcarNoShow(turno.fecha_hora_inicio, ahora)}
          onClick={() => void ejecutar(Accion.NoShow, null)}
        >
          No-show
        </button>
      </div>

      {cancelando ? (
        <div className="acciones-turno__cancelar">
          <label htmlFor={`motivo-${turno.id}`}>Motivo de cancelación</label>
          <input
            id={`motivo-${turno.id}`}
            type="text"
            value={motivo}
            onChange={(evento) => setMotivo(evento.target.value)}
          />
          {errorMotivo !== null ? <p role="alert">{errorMotivo}</p> : null}
          <button type="button" disabled={pendiente} onClick={confirmarCancelacion}>
            Confirmar cancelación
          </button>
        </div>
      ) : null}
    </div>
  );
}
