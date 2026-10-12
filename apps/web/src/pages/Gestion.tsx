import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { SlotPicker } from "../components/SlotPicker";
import {
  apiClient,
  mensajeDeError,
  resolverServicioPorNombre,
} from "../lib/apiClient";
import type {
  DiaAgenda,
  ServicioPublico,
  Slot,
  TurnoAccionResultado,
  TurnoGestion,
} from "../lib/apiClient";
import {
  fechaEnZona,
  formatearFechaLarga,
  formatearHoraLocal,
  ventanaDeReserva,
} from "../lib/fechas";

/**
 * Página de gestión por enlace (`/g/{token}`, T-13).
 *
 * GET /turnos/{token} → tarjeta del turno (estado, servicio, fecha/hora local
 * del negocio, cliente). Acciones: confirmar (POST .../confirmar, T-11),
 * cancelar y reagendar (POST .../cancelar y .../reagendar — endpoints
 * implementados en T-14; aquí se cablean al contrato).
 *
 * Gap de contrato: `TurnoGestion` no expone `servicio_id` ni `zona_horaria`.
 * Se resuelve el servicio del turno desde la lista pública (match por nombre)
 * para presentar la hora local del negocio y habilitar el selector de
 * reagenda. Reportado como desviación.
 */

const DIAS_VENTANA = 7;

export function Gestion() {
  const { token } = useParams<{ token: string }>();

  const [turno, setTurno] = useState<TurnoGestion | null>(null);
  const [estado, setEstado] = useState<TurnoGestion["estado"] | null>(null);
  const [servicio, setServicio] = useState<ServicioPublico | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [accionPendiente, setAccionPendiente] = useState(false);
  const [reagendarAbierto, setReagendarAbierto] = useState(false);
  const [dias, setDias] = useState<DiaAgenda[]>([]);
  const [slotNuevo, setSlotNuevo] = useState<Slot | null>(null);

  useEffect(() => {
    if (token === undefined) return;
    let activo = true;
    setCargando(true);
    Promise.all([
      apiClient.obtenerTurnoPorToken(token),
      apiClient.listarServicios(),
    ])
      .then(([datosTurno, servicios]) => {
        if (!activo) return;
        setTurno(datosTurno);
        setEstado(datosTurno.estado);
        setServicio(
          resolverServicioPorNombre(servicios, datosTurno.servicio) ?? null,
        );
        setCargando(false);
      })
      .catch((fallo: unknown) => {
        if (!activo) return;
        setError(mensajeDeError(fallo));
        setCargando(false);
      });
    return () => {
      activo = false;
    };
  }, [token]);

  async function ejecutarAccion(
    accion: () => Promise<TurnoAccionResultado>,
    mensajeExito: string,
  ) {
    setAccionPendiente(true);
    setError(null);
    setMensaje(null);
    try {
      const resultado = await accion();
      setEstado(resultado.estado);
      setMensaje(mensajeExito);
    } catch (fallo: unknown) {
      setError(mensajeDeError(fallo));
    } finally {
      setAccionPendiente(false);
    }
  }

  function abrirReagendar() {
    setReagendarAbierto(true);
    setError(null);
    if (servicio === null) return;
    const { desde, hasta } = ventanaDeReserva(
      new Date(),
      servicio.zona_horaria,
      DIAS_VENTANA,
    );
    apiClient
      .calcularAgenda({ servicio_id: servicio.id, desde, hasta })
      .then((agenda) => setDias(agenda.dias))
      .catch((fallo: unknown) => setError(mensajeDeError(fallo)));
  }

  async function confirmarReagendar() {
    if (token === undefined || slotNuevo === null) return;
    setAccionPendiente(true);
    setError(null);
    setMensaje(null);
    try {
      const resultado = await apiClient.reagendarTurno(token, slotNuevo.slot_key);
      setEstado(resultado.estado);
      if (
        turno !== null &&
        resultado.fecha_hora_inicio !== undefined &&
        resultado.fecha_hora_fin !== undefined
      ) {
        setTurno({
          ...turno,
          fecha_hora_inicio: resultado.fecha_hora_inicio,
          fecha_hora_fin: resultado.fecha_hora_fin,
        });
      }
      setMensaje("Turno reagendado.");
      setReagendarAbierto(false);
      setSlotNuevo(null);
    } catch (fallo: unknown) {
      setError(mensajeDeError(fallo));
    } finally {
      setAccionPendiente(false);
    }
  }

  if (cargando) {
    return (
      <section aria-label="Gestión de turno">
        <h2>Gestión de turno</h2>
        <p role="status">Cargando tu turno…</p>
      </section>
    );
  }

  if (turno === null) {
    return (
      <section aria-label="Gestión de turno">
        <h2>Gestión de turno</h2>
        <p role="alert">{error ?? "No encontramos este turno."}</p>
      </section>
    );
  }

  const zonaHoraria = servicio?.zona_horaria ?? "UTC";
  const fechaLocal = fechaEnZona(new Date(turno.fecha_hora_inicio), zonaHoraria);

  return (
    <section aria-label="Gestión de turno">
      <h2>Gestión de turno</h2>

      <dl className="turno-card">
        <dt>Servicio</dt>
        <dd>{turno.servicio}</dd>
        <dt>Cliente</dt>
        <dd>{turno.cliente_nombre}</dd>
        <dt>Estado</dt>
        <dd>{estado}</dd>
        <dt>Fecha</dt>
        <dd>{formatearFechaLarga(fechaLocal)}</dd>
        <dt>Hora</dt>
        <dd>{formatearHoraLocal(turno.fecha_hora_inicio, zonaHoraria)}</dd>
      </dl>

      {mensaje !== null ? (
        <p role="status" aria-live="polite">
          {mensaje}
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" aria-live="assertive">
          {error}
        </p>
      ) : null}

      <div className="turno-acciones">
        <button
          type="button"
          disabled={accionPendiente}
          onClick={() =>
            ejecutarAccion(
              () => apiClient.confirmarTurno(token ?? ""),
              "Turno confirmado.",
            )
          }
        >
          Confirmar
        </button>
        <button
          type="button"
          disabled={accionPendiente}
          onClick={() =>
            ejecutarAccion(
              () => apiClient.cancelarTurno(token ?? ""),
              "Turno cancelado.",
            )
          }
        >
          Cancelar
        </button>
        <button type="button" onClick={abrirReagendar}>
          Reagendar
        </button>
      </div>

      {reagendarAbierto ? (
        <section aria-label="Reagendar turno" className="turno-reagendar">
          <h3>Reagendar turno</h3>
          <SlotPicker
            dias={dias}
            zonaHoraria={zonaHoraria}
            seleccionado={slotNuevo?.slot_key ?? null}
            onSeleccionar={setSlotNuevo}
          />
          <button
            type="button"
            disabled={slotNuevo === null || accionPendiente}
            onClick={confirmarReagendar}
          >
            Confirmar cambio
          </button>
        </section>
      ) : null}
    </section>
  );
}
