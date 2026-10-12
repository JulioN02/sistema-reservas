/**
 * Utilidades de fecha/hora puras para la SPA.
 *
 * Toda presentación de instantes se hace en la zona horaria del negocio
 * (RNF-10, RB-VNG-01); los cálculos de "hoy" y ventanas también (AD-06).
 * Funciones puras y deterministas (fáciles de testear sin mocks).
 */

export interface RangoFechas {
  /** Fecha inicial inclusive (YYYY-MM-DD) en la zona del negocio. */
  desde: string;
  /** Fecha final exclusive (YYYY-MM-DD) en la zona del negocio. */
  hasta: string;
}

/** Fecha local (YYYY-MM-DD) de un instante en la zona horaria dada. */
export function fechaEnZona(instante: Date, zonaHoraria: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zonaHoraria,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instante);
}

/** Suma `dias` a una fecha `YYYY-MM-DD` (aritmética en UTC, sin DST). */
export function sumarDias(fecha: string, dias: number): string {
  const [anio, mes, dia] = fecha.split("-").map(Number);
  const base = new Date(
    Date.UTC(anio ?? 1970, (mes ?? 1) - 1, dia ?? 1),
  );
  base.setUTCDate(base.getUTCDate() + dias);
  return base.toISOString().slice(0, 10);
}

/** Ventana de reserva: `dias` días desde hoy en la zona del negocio. */
export function ventanaDeReserva(
  ahora: Date,
  zonaHoraria: string,
  dias = 7,
): RangoFechas {
  const desde = fechaEnZona(ahora, zonaHoraria);
  return { desde, hasta: sumarDias(desde, dias) };
}

/** Hora local (HH:MM) de un instante ISO en la zona horaria dada. */
export function formatearHoraLocal(iso: string, zonaHoraria: string): string {
  return new Intl.DateTimeFormat("es", {
    timeZone: zonaHoraria,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** Fecha larga en español neutro (p. ej. "lunes, 5 de octubre"). */
export function formatearFechaLarga(fecha: string): string {
  return new Intl.DateTimeFormat("es", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${fecha}T12:00:00.000Z`));
}

/** Hora local del inicio contenido en un `slot_key` (`<iso>|<servicio_id>`). */
export function horaDeSlotKey(slotKey: string, zonaHoraria: string): string {
  const iso = slotKey.split("|")[0];
  if (iso === undefined || iso === "") return slotKey;
  return formatearHoraLocal(iso, zonaHoraria);
}
