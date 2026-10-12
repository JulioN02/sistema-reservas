import type { DiaAgenda, Slot } from "../lib/apiClient";
import { formatearFechaLarga, formatearHoraLocal } from "../lib/fechas";

/**
 * Selector de horarios por día (agenda calculada — RB-AGD-07).
 *
 * Accesibilidad (WCAG AA base): cada día es una sección con encabezado;
 * los slots son botones nativos (foco por teclado) y el seleccionado se
 * marca con `aria-current`/`aria-pressed`; los días sin oferta muestran un
 * estado `role="status"`.
 */
export interface SlotPickerProps {
  dias: DiaAgenda[];
  /** Zona horaria IANA del negocio (presentación de la hora local). */
  zonaHoraria: string;
  /** `slot_key` seleccionado, o `null` si aún no hay selección. */
  seleccionado: string | null;
  onSeleccionar: (slot: Slot) => void;
}

export function SlotPicker({
  dias,
  zonaHoraria,
  seleccionado,
  onSeleccionar,
}: SlotPickerProps) {
  return (
    <div className="slot-picker">
      {dias.map((dia) => (
        <section key={dia.fecha} className="slot-picker__dia">
          <h3 className="slot-picker__fecha">
            {formatearFechaLarga(dia.fecha)}
          </h3>
          {dia.slots.length === 0 ? (
            <p role="status" className="slot-picker__vacio">
              Sin horarios disponibles
            </p>
          ) : (
            <ul className="slot-picker__lista">
              {dia.slots.map((slot) => {
                const esSeleccionado = slot.slot_key === seleccionado;
                return (
                  <li key={slot.slot_key}>
                    <button
                      type="button"
                      className="slot-picker__slot"
                      aria-current={esSeleccionado ? "true" : undefined}
                      aria-pressed={esSeleccionado}
                      onClick={() => onSeleccionar(slot)}
                    >
                      {formatearHoraLocal(slot.fecha_hora_inicio, zonaHoraria)}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
