import { useActionState, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { usePanel } from "../components/PanelContext";
import type { Bloque, ErrorCampo, Horario, ServicioPublico } from "../lib/apiClient";
import {
  ApiError,
  apiClient,
  erroresDeCampo,
  esNoAutorizado,
  mensajeDeError,
} from "../lib/apiClient";

/**
 * Gestión de agenda del negocio (T-17): CRUD de horarios recurrentes y
 * bloques de indisponibilidad + creación de servicios y edición de sus
 * parámetros. Formularios con `useActionState` (React 19).
 *
 * Errores visibles: 409 (solape/bloque sobre turnos activos) y 422 (validación
 * por campo). La validación de UI es solo UX; el backend es la fuente de verdad.
 */

interface ResultadoForm {
  ok: boolean;
  mensaje: string;
  errores: ErrorCampo[];
}

const RESULTADO_INICIAL: ResultadoForm = { ok: false, mensaje: "", errores: [] };

function resultadoDeError(fallo: unknown): ResultadoForm {
  if (fallo instanceof ApiError) {
    return {
      ok: false,
      mensaje: fallo.problem.detail,
      errores: erroresDeCampo(fallo),
    };
  }
  return {
    ok: false,
    mensaje: "Ocurrió un error inesperado. Intenta nuevamente.",
    errores: [],
  };
}

/** Mensaje + errores por campo de un formulario de gestión. */
function Resultado({ resultado }: { resultado: ResultadoForm }) {
  return (
    <>
      {resultado.mensaje !== "" ? (
        resultado.ok ? (
          <p role="status" className="gestion__ok">
            {resultado.mensaje}
          </p>
        ) : (
          <p role="alert" className="gestion__error">
            {resultado.mensaje}
          </p>
        )
      ) : null}
      {resultado.errores.length > 0 ? (
        <ul className="errores-campo" role="alert">
          {resultado.errores.map((error) => (
            <li key={error.campo}>
              {error.campo}: {error.mensaje}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

const NOMBRES_DIA = [
  "",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
  "Domingo",
] as const;

function nombreDia(dia: number): string {
  return NOMBRES_DIA[dia] ?? `Día ${dia}`;
}

function FormularioHorario({
  zonaHoraria,
  onExito,
}: {
  zonaHoraria: string;
  onExito: () => void;
}) {
  const navigate = useNavigate();

  async function enviar(
    _previo: ResultadoForm,
    formData: FormData,
  ): Promise<ResultadoForm> {
    const dia_semana = Number(formData.get("dia_semana"));
    const hora_inicio = String(formData.get("hora_inicio") ?? "");
    const hora_fin = String(formData.get("hora_fin") ?? "");
    try {
      await apiClient.crearHorario({
        dia_semana,
        hora_inicio,
        hora_fin,
        timezone: zonaHoraria,
      });
      onExito();
      return { ok: true, mensaje: "Horario creado.", errores: [] };
    } catch (fallo: unknown) {
      if (esNoAutorizado(fallo)) {
        navigate("/login");
        return RESULTADO_INICIAL;
      }
      return resultadoDeError(fallo);
    }
  }

  const [resultado, formAction, pendiente] = useActionState(
    enviar,
    RESULTADO_INICIAL,
  );

  return (
    <form action={formAction} className="gestion__form">
      <h4>Nuevo horario</h4>
      <div className="gestion__campo">
        <label htmlFor="horario-dia">Día</label>
        <select id="horario-dia" name="dia_semana" defaultValue="1">
          {[1, 2, 3, 4, 5, 6, 7].map((dia) => (
            <option key={dia} value={dia}>
              {nombreDia(dia)}
            </option>
          ))}
        </select>
      </div>
      <div className="gestion__campo">
        <label htmlFor="horario-inicio">Hora de inicio</label>
        <input id="horario-inicio" name="hora_inicio" type="time" />
      </div>
      <div className="gestion__campo">
        <label htmlFor="horario-fin">Hora de fin</label>
        <input id="horario-fin" name="hora_fin" type="time" />
      </div>
      <Resultado resultado={resultado} />
      <button type="submit" disabled={pendiente}>
        Crear horario
      </button>
    </form>
  );
}

function FormularioBloque({ onExito }: { onExito: () => void }) {
  const navigate = useNavigate();

  async function enviar(
    _previo: ResultadoForm,
    formData: FormData,
  ): Promise<ResultadoForm> {
    const inicio = String(formData.get("fecha_inicio") ?? "");
    const fin = String(formData.get("fecha_fin") ?? "");
    const motivo = String(formData.get("motivo") ?? "").trim();
    try {
      await apiClient.crearBloque({
        fecha_inicio: new Date(inicio).toISOString(),
        fecha_fin: new Date(fin).toISOString(),
        motivo: motivo === "" ? null : motivo,
      });
      onExito();
      return { ok: true, mensaje: "Bloque creado.", errores: [] };
    } catch (fallo: unknown) {
      if (esNoAutorizado(fallo)) {
        navigate("/login");
        return RESULTADO_INICIAL;
      }
      return resultadoDeError(fallo);
    }
  }

  const [resultado, formAction, pendiente] = useActionState(
    enviar,
    RESULTADO_INICIAL,
  );

  return (
    <form action={formAction} className="gestion__form">
      <h4>Nuevo bloque</h4>
      <div className="gestion__campo">
        <label htmlFor="bloque-inicio">Inicio</label>
        <input id="bloque-inicio" name="fecha_inicio" type="datetime-local" />
      </div>
      <div className="gestion__campo">
        <label htmlFor="bloque-fin">Fin</label>
        <input id="bloque-fin" name="fecha_fin" type="datetime-local" />
      </div>
      <div className="gestion__campo">
        <label htmlFor="bloque-motivo">Motivo (opcional)</label>
        <input id="bloque-motivo" name="motivo" type="text" />
      </div>
      <Resultado resultado={resultado} />
      <button type="submit" disabled={pendiente}>
        Crear bloque
      </button>
    </form>
  );
}

function FormularioServicio({ onExito }: { onExito: () => void }) {
  const navigate = useNavigate();

  async function enviar(
    _previo: ResultadoForm,
    formData: FormData,
  ): Promise<ResultadoForm> {
    const nombre = String(formData.get("nombre") ?? "").trim();
    const duracion_min = Number(formData.get("duracion_min"));
    const precioTexto = String(formData.get("precio") ?? "").trim();
    try {
      await apiClient.crearServicio({
        nombre,
        duracion_min,
        precio: precioTexto === "" ? null : Number(precioTexto),
        // Parámetros de reserva con los defaults del contrato (RB-AGD-02,
        // RB-CRG-01); se editan luego con el formulario de parámetros.
        booking_window_days: 30,
        cancellation_grace_minutes: 180,
        activo: true,
      });
      onExito();
      return { ok: true, mensaje: "Servicio creado.", errores: [] };
    } catch (fallo: unknown) {
      if (esNoAutorizado(fallo)) {
        navigate("/login");
        return RESULTADO_INICIAL;
      }
      return resultadoDeError(fallo);
    }
  }

  const [resultado, formAction, pendiente] = useActionState(
    enviar,
    RESULTADO_INICIAL,
  );

  return (
    <form action={formAction} className="gestion__form">
      <h4>Nuevo servicio</h4>
      <div className="gestion__campo">
        <label htmlFor="servicio-nombre">Nombre del servicio</label>
        <input id="servicio-nombre" name="nombre" type="text" />
      </div>
      <div className="gestion__campo">
        <label htmlFor="servicio-duracion">Duración (min)</label>
        <input
          id="servicio-duracion"
          name="duracion_min"
          type="number"
          min={15}
          step={15}
        />
      </div>
      <div className="gestion__campo">
        <label htmlFor="servicio-precio">Precio (opcional)</label>
        <input id="servicio-precio" name="precio" type="number" min={0} />
      </div>
      <Resultado resultado={resultado} />
      <button type="submit" disabled={pendiente}>
        Crear servicio
      </button>
    </form>
  );
}

function FormularioParametros({
  servicio,
  onExito,
}: {
  servicio: ServicioPublico;
  onExito: () => void;
}) {
  const navigate = useNavigate();

  async function enviar(
    _previo: ResultadoForm,
    formData: FormData,
  ): Promise<ResultadoForm> {
    try {
      await apiClient.actualizarParametrosServicio(servicio.id, {
        booking_window_days: Number(formData.get("booking_window_days")),
        cancellation_grace_minutes: Number(
          formData.get("cancellation_grace_minutes"),
        ),
        activo: formData.get("activo") !== null,
      });
      onExito();
      return { ok: true, mensaje: "Parámetros actualizados.", errores: [] };
    } catch (fallo: unknown) {
      if (esNoAutorizado(fallo)) {
        navigate("/login");
        return RESULTADO_INICIAL;
      }
      return resultadoDeError(fallo);
    }
  }

  const [resultado, formAction, pendiente] = useActionState(
    enviar,
    RESULTADO_INICIAL,
  );

  return (
    <form action={formAction} className="gestion__form gestion__form--parametros">
      <h5>Parámetros de {servicio.nombre}</h5>
      <div className="gestion__campo">
        <label htmlFor={`ventana-${servicio.id}`}>Ventana de reserva (días)</label>
        <input
          id={`ventana-${servicio.id}`}
          name="booking_window_days"
          type="number"
          min={1}
          max={90}
          defaultValue={30}
        />
      </div>
      <div className="gestion__campo">
        <label htmlFor={`gracia-${servicio.id}`}>
          Gracia de cancelación (min)
        </label>
        <input
          id={`gracia-${servicio.id}`}
          name="cancellation_grace_minutes"
          type="number"
          min={30}
          max={1440}
          defaultValue={180}
        />
      </div>
      <label htmlFor={`activo-${servicio.id}`}>
        <input
          id={`activo-${servicio.id}`}
          name="activo"
          type="checkbox"
          defaultChecked
        />
        Activo
      </label>
      <Resultado resultado={resultado} />
      <button type="submit" disabled={pendiente}>
        Guardar parámetros
      </button>
    </form>
  );
}

export function GestionAgenda() {
  const { zonaHoraria } = usePanel();
  const navigate = useNavigate();
  const [horarios, setHorarios] = useState<Horario[]>([]);
  const [bloques, setBloques] = useState<Bloque[]>([]);
  const [servicios, setServicios] = useState<ServicioPublico[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let activo = true;
    Promise.all([
      apiClient.listarHorarios(),
      apiClient.listarBloques(),
      apiClient.listarServicios(),
    ])
      .then(([listaHorarios, listaBloques, listaServicios]) => {
        if (!activo) return;
        setHorarios(listaHorarios);
        setBloques(listaBloques);
        setServicios(listaServicios);
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
  }, [recarga, navigate]);

  async function eliminar(accion: () => Promise<void>) {
    try {
      await accion();
      setRecarga((n) => n + 1);
    } catch (fallo: unknown) {
      if (esNoAutorizado(fallo)) {
        navigate("/login");
        return;
      }
      setError(mensajeDeError(fallo));
    }
  }

  return (
    <section aria-label="Gestión de agenda" className="gestion">
      <h3>Agenda</h3>

      {error !== null ? <p role="alert">{error}</p> : null}

      {cargando ? (
        <p role="status">Cargando agenda…</p>
      ) : (
        <>
          <section aria-label="Horarios" className="gestion__seccion">
            <h4>Horarios recurrentes</h4>
            {horarios.length === 0 ? (
              <p role="status">No hay horarios cargados.</p>
            ) : (
              <ul className="gestion__lista">
                {horarios.map((horario) => (
                  <li key={horario.id}>
                    <span>
                      {nombreDia(horario.dia_semana)} · {horario.hora_inicio}–
                      {horario.hora_fin}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void eliminar(() => apiClient.eliminarHorario(horario.id))
                      }
                    >
                      Eliminar
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <FormularioHorario
              zonaHoraria={zonaHoraria}
              onExito={() => setRecarga((n) => n + 1)}
            />
          </section>

          <section aria-label="Bloques" className="gestion__seccion">
            <h4>Bloques de indisponibilidad</h4>
            {bloques.length === 0 ? (
              <p role="status">No hay bloques cargados.</p>
            ) : (
              <ul className="gestion__lista">
                {bloques.map((bloque) => (
                  <li key={bloque.id}>
                    <span>
                      {bloque.fecha_inicio} – {bloque.fecha_fin}
                      {bloque.motivo !== null ? ` · ${bloque.motivo}` : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void eliminar(() => apiClient.eliminarBloque(bloque.id))
                      }
                    >
                      Eliminar
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <FormularioBloque onExito={() => setRecarga((n) => n + 1)} />
          </section>

          <section aria-label="Servicios" className="gestion__seccion">
            <h4>Servicios</h4>
            {servicios.length === 0 ? (
              <p role="status">No hay servicios cargados.</p>
            ) : (
              <ul className="gestion__lista">
                {servicios.map((servicio) => (
                  <li key={servicio.id}>
                    <span>
                      {servicio.nombre} · {servicio.duracion_min} min
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void eliminar(() => apiClient.eliminarServicio(servicio.id))
                      }
                    >
                      Eliminar
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <FormularioServicio onExito={() => setRecarga((n) => n + 1)} />
            {servicios.map((servicio) => (
              <FormularioParametros
                key={`parametros-${servicio.id}`}
                servicio={servicio}
                onExito={() => setRecarga((n) => n + 1)}
              />
            ))}
          </section>
        </>
      )}
    </section>
  );
}
