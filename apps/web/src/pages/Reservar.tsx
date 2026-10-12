import { useEffect, useState } from "react";
import { FormularioContacto } from "../components/FormularioContacto";
import { SlotPicker } from "../components/SlotPicker";
import { apiClient, mensajeDeError } from "../lib/apiClient";
import type {
  DiaAgenda,
  ServicioPublico,
  Slot,
  TurnoCreado,
} from "../lib/apiClient";
import { ventanaDeReserva } from "../lib/fechas";

/**
 * Flujo público de reserva (T-13, RNF-05): ≤3 pasos.
 *
 *   1. Elegir servicio (GET /servicios).
 *   2. Elegir horario (GET /agenda, ventana de 7 días en zona del negocio).
 *   3. Datos + consentimiento (POST /turnos) → pantalla de éxito con el
 *      enlace de gestión absoluto.
 *
 * Navegación hacia atrás entre pasos; estados de carga/error; alternativas
 * del 409 expuestas en el formulario.
 */

const Paso = {
  Servicio: 1,
  Horario: 2,
  Datos: 3,
} as const;
type Paso = (typeof Paso)[keyof typeof Paso];

const DIAS_VENTANA = 7;

/** Busca un slot por `slot_key` dentro de la agenda cargada. */
function buscarSlot(dias: DiaAgenda[], slotKey: string): Slot | null {
  for (const dia of dias) {
    for (const slot of dia.slots) {
      if (slot.slot_key === slotKey) return slot;
    }
  }
  return null;
}

export function Reservar() {
  const [paso, setPaso] = useState<Paso>(Paso.Servicio);
  const [servicios, setServicios] = useState<ServicioPublico[]>([]);
  const [cargandoServicios, setCargandoServicios] = useState(true);
  const [servicio, setServicio] = useState<ServicioPublico | null>(null);
  const [dias, setDias] = useState<DiaAgenda[]>([]);
  const [cargandoAgenda, setCargandoAgenda] = useState(false);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [turno, setTurno] = useState<TurnoCreado | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let activo = true;
    setCargandoServicios(true);
    apiClient
      .listarServicios()
      .then((lista) => {
        if (!activo) return;
        setServicios(lista);
        setCargandoServicios(false);
      })
      .catch((fallo: unknown) => {
        if (!activo) return;
        setError(mensajeDeError(fallo));
        setCargandoServicios(false);
      });
    return () => {
      activo = false;
    };
  }, []);

  useEffect(() => {
    if (servicio === null) return;
    let activo = true;
    setCargandoAgenda(true);
    const { desde, hasta } = ventanaDeReserva(
      new Date(),
      servicio.zona_horaria,
      DIAS_VENTANA,
    );
    apiClient
      .calcularAgenda({ servicio_id: servicio.id, desde, hasta })
      .then((agenda) => {
        if (!activo) return;
        setDias(agenda.dias);
        setCargandoAgenda(false);
      })
      .catch((fallo: unknown) => {
        if (!activo) return;
        setError(mensajeDeError(fallo));
        setCargandoAgenda(false);
      });
    return () => {
      activo = false;
    };
  }, [servicio]);

  function elegirServicio(elegido: ServicioPublico) {
    setServicio(elegido);
    setSlot(null);
    setError(null);
    setPaso(Paso.Horario);
  }

  function elegirSlot(elegido: Slot) {
    setSlot(elegido);
    setPaso(Paso.Datos);
  }

  function volver() {
    setError(null);
    setPaso((actual) => (actual > Paso.Servicio ? ((actual - 1) as Paso) : actual));
  }

  if (turno !== null) {
    const enlaceAbsoluto = new URL(
      turno.enlace_gestion,
      window.location.origin,
    ).toString();
    return (
      <section aria-label="Reserva confirmada">
        <h2>Reserva confirmada</h2>
        <p>
          Tu turno quedó registrado. Guarda este enlace para confirmar, cancelar
          o reagendar tu reserva.
        </p>
        <p>
          <a href={enlaceAbsoluto}>Gestionar mi turno</a>
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Reserva de turno">
      <h2>Reservar turno</h2>

      <ol className="pasos" aria-label="Progreso de la reserva">
        <li aria-current={paso === Paso.Servicio ? "step" : undefined}>
          Servicio
        </li>
        <li aria-current={paso === Paso.Horario ? "step" : undefined}>
          Horario
        </li>
        <li aria-current={paso === Paso.Datos ? "step" : undefined}>Datos</li>
      </ol>

      {error !== null ? (
        <p role="alert" className="reservar__error">
          {error}
        </p>
      ) : null}

      {paso === Paso.Servicio ? (
        <section className="reservar__servicios">
          <h3>Elige un servicio</h3>
          {cargandoServicios ? <p role="status">Cargando servicios…</p> : null}
          {!cargandoServicios && servicios.length === 0 ? (
            <p role="status">No hay servicios disponibles por ahora.</p>
          ) : null}
          <ul className="reservar__lista-servicios">
            {servicios.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => elegirServicio(item)}>
                  {item.nombre} · {item.duracion_min} min
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {paso === Paso.Horario && servicio !== null ? (
        <section className="reservar__horarios">
          <h3>Elige un horario</h3>
          {cargandoAgenda ? (
            <p role="status">Cargando horarios…</p>
          ) : dias.length === 0 ? (
            <p role="status">
              No hay horarios disponibles en los próximos días.
            </p>
          ) : (
            <SlotPicker
              dias={dias}
              zonaHoraria={servicio.zona_horaria}
              seleccionado={slot?.slot_key ?? null}
              onSeleccionar={elegirSlot}
            />
          )}
          <button type="button" onClick={volver}>
            Volver
          </button>
        </section>
      ) : null}

      {paso === Paso.Datos && servicio !== null && slot !== null ? (
        <section className="reservar__datos">
          <h3>Tus datos</h3>
          <FormularioContacto
            servicioId={servicio.id}
            slotKey={slot.slot_key}
            zonaHoraria={servicio.zona_horaria}
            onCreado={setTurno}
            onVolver={volver}
            onSeleccionarAlternativa={(slotKey) => {
              const alternativo = buscarSlot(dias, slotKey);
              if (alternativo !== null) setSlot(alternativo);
            }}
          />
        </section>
      ) : null}
    </section>
  );
}
