import { useActionState } from "react";
import { ApiError, apiClient } from "../lib/apiClient";
import type { TurnoCreado } from "../lib/apiClient";
import { horaDeSlotKey } from "../lib/fechas";

/**
 * Paso 3 del flujo de reserva: datos de contacto + consentimiento.
 *
 * `useActionState` (React 19) gestiona el estado pendiente del formulario.
 * La validación de aquí es SOLO UX (nombre, al menos un canal, consentimiento);
 * el DTO del backend es la fuente de verdad (RNF-03, RST-05). El consentimiento
 * es obligatorio (PRV-01): sin él no se envía nada.
 */

const EstadoFormulario = {
  Inicial: "inicial",
  Error: "error",
  Conflicto: "conflicto",
} as const;
type EstadoFormulario = (typeof EstadoFormulario)[keyof typeof EstadoFormulario];

interface ResultadoFormulario {
  estado: EstadoFormulario;
  mensaje: string;
  alternativas: string[];
}

const RESULTADO_INICIAL: ResultadoFormulario = {
  estado: EstadoFormulario.Inicial,
  mensaje: "",
  alternativas: [],
};

export interface FormularioContactoProps {
  servicioId: string;
  slotKey: string;
  /** Zona horaria del negocio (presentación de las alternativas del 409). */
  zonaHoraria: string;
  onCreado: (turno: TurnoCreado) => void;
  onVolver: () => void;
  onSeleccionarAlternativa: (slotKey: string) => void;
}

export function FormularioContacto({
  servicioId,
  slotKey,
  zonaHoraria,
  onCreado,
  onVolver,
  onSeleccionarAlternativa,
}: FormularioContactoProps) {
  async function enviar(
    _previo: ResultadoFormulario,
    formData: FormData,
  ): Promise<ResultadoFormulario> {
    const nombre = String(formData.get("nombre") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();
    const telefono = String(formData.get("telefono") ?? "").trim();
    const consentimiento = formData.get("consentimiento") !== null;

    if (nombre === "") {
      return {
        estado: EstadoFormulario.Error,
        mensaje: "Ingresa tu nombre.",
        alternativas: [],
      };
    }
    if (email === "" && telefono === "") {
      return {
        estado: EstadoFormulario.Error,
        mensaje: "Ingresa un email o un teléfono de contacto.",
        alternativas: [],
      };
    }
    if (!consentimiento) {
      return {
        estado: EstadoFormulario.Error,
        mensaje:
          "Debes aceptar el consentimiento para guardar tus datos y recibir las comunicaciones del turno.",
        alternativas: [],
      };
    }

    try {
      const turno = await apiClient.crearTurno({
        servicio_id: servicioId,
        slot_key: slotKey,
        cliente: {
          nombre,
          email: email === "" ? null : email,
          telefono: telefono === "" ? null : telefono,
        },
        consentimiento: true,
      });
      onCreado(turno);
      return RESULTADO_INICIAL;
    } catch (error) {
      if (error instanceof ApiError) {
        return {
          estado:
            error.status === 409
              ? EstadoFormulario.Conflicto
              : EstadoFormulario.Error,
          mensaje: error.problem.detail,
          alternativas: error.problem.alternativas ?? [],
        };
      }
      return {
        estado: EstadoFormulario.Error,
        mensaje: "No se pudo completar la reserva. Intenta nuevamente.",
        alternativas: [],
      };
    }
  }

  const [resultado, formAction, pendiente] = useActionState(
    enviar,
    RESULTADO_INICIAL,
  );

  return (
    <form action={formAction} className="formulario-contacto">
      {resultado.estado !== EstadoFormulario.Inicial ? (
        <p role="alert" aria-live="assertive" className="formulario-contacto__error">
          {resultado.mensaje}
        </p>
      ) : null}

      {resultado.alternativas.length > 0 ? (
        <div className="formulario-contacto__alternativas">
          <h4>Horarios alternativos disponibles</h4>
          <ul>
            {resultado.alternativas.map((alternativa) => (
              <li key={alternativa}>
                <button
                  type="button"
                  onClick={() => onSeleccionarAlternativa(alternativa)}
                >
                  {horaDeSlotKey(alternativa, zonaHoraria)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="formulario-contacto__campo">
        <label htmlFor="nombre">Nombre</label>
        <input
          id="nombre"
          name="nombre"
          type="text"
          autoComplete="name"
          aria-required="true"
        />
      </div>

      <div className="formulario-contacto__campo">
        <label htmlFor="email">Email (opcional)</label>
        <input id="email" name="email" type="email" autoComplete="email" />
      </div>

      <div className="formulario-contacto__campo">
        <label htmlFor="telefono">Teléfono (opcional)</label>
        <input id="telefono" name="telefono" type="tel" autoComplete="tel" />
      </div>

      <label htmlFor="consentimiento" className="formulario-contacto__consentimiento">
        <input
          id="consentimiento"
          name="consentimiento"
          type="checkbox"
          aria-required="true"
        />
        Acepto el consentimiento: el negocio guardará mis datos y me contactará
        por mi turno.
      </label>

      <div className="formulario-contacto__acciones">
        <button type="button" onClick={onVolver}>
          Volver
        </button>
        <button type="submit" disabled={pendiente}>
          {pendiente ? "Enviando…" : "Confirmar reserva"}
        </button>
      </div>
    </form>
  );
}
