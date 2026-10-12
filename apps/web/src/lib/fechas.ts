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

/**
 * Offset (minutos) de la zona respecto de UTC para un instante dado.
 * `comoUtc - instante` da la diferencia entre la hora de pared en la zona y
 * la hora UTC (negativo al oeste de Greenwich).
 */
function offsetMinutos(instante: Date, zonaHoraria: string): number {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: zonaHoraria,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instante);
  const valor = (tipo: string): number =>
    Number(partes.find((parte) => parte.type === tipo)?.value ?? "0");
  const comoUtc = Date.UTC(
    valor("year"),
    valor("month") - 1,
    valor("day"),
    valor("hour"),
    valor("minute"),
    valor("second"),
  );
  return (comoUtc - instante.getTime()) / 60_000;
}

/** Instante UTC del inicio del día `YYYY-MM-DD` en la zona del negocio (RB-VNG-01). */
export function inicioDelDiaUtc(fecha: string, zonaHoraria: string): string {
  const [anio, mes, dia] = fecha.split("-").map(Number);
  const medianocheUtc = Date.UTC(anio ?? 1970, (mes ?? 1) - 1, dia ?? 1);
  const offset = offsetMinutos(new Date(medianocheUtc), zonaHoraria);
  return new Date(medianocheUtc - offset * 60_000).toISOString();
}

/** Instante UTC del fin (exclusivo) del día `YYYY-MM-DD` en la zona del negocio. */
export function finDelDiaUtc(fecha: string, zonaHoraria: string): string {
  return inicioDelDiaUtc(sumarDias(fecha, 1), zonaHoraria);
}
