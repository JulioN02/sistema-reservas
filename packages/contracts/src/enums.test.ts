import { describe, expect, it } from "vitest";
import {
  EventoOrigen,
  EventoTipo,
  RecordatorioCanal,
  RecordatorioEstado,
  TurnoEstado,
  TurnoEstadosActivos,
} from "./enums";

const enums = {
  TurnoEstado,
  RecordatorioCanal,
  RecordatorioEstado,
  EventoTipo,
  EventoOrigen,
} as const;

describe("enums compartidos (patrón const types)", () => {
  it.each(Object.entries(enums))(
    "%s define valores únicos sin duplicados",
    (_nombre, enumeracion) => {
      const valores = Object.values(enumeracion);
      expect(new Set(valores).size).toBe(valores.length);
    },
  );

  it("TurnoEstado coincide con el enum Postgres turno_estado", () => {
    expect(Object.values(TurnoEstado)).toEqual([
      "pendiente",
      "confirmado",
      "completado",
      "cancelado",
      "no_show",
    ]);
  });

  it("RecordatorioCanal coincide con el enum Postgres recordatorio_canal", () => {
    expect(Object.values(RecordatorioCanal)).toEqual(["email", "log"]);
  });

  it("RecordatorioEstado coincide con el enum Postgres recordatorio_estado", () => {
    expect(Object.values(RecordatorioEstado)).toEqual([
      "programado",
      "enviado",
      "fallido",
      "cancelado",
    ]);
  });

  it("EventoTipo coincide con el enum Postgres evento_tipo", () => {
    expect(Object.values(EventoTipo)).toEqual([
      "reserva_creada",
      "reserva_confirmada",
      "cancelacion",
      "reagendulacion",
      "recordatorio_enviado",
      "recordatorio_fallido",
      "completado",
      "no_show",
    ]);
  });

  it("EventoOrigen coincide con el enum Postgres evento_origen", () => {
    expect(Object.values(EventoOrigen)).toEqual([
      "public",
      "business",
      "system",
    ]);
  });

  it("TurnoEstadosActivos contiene solo estados activos (ocupan slot)", () => {
    expect(TurnoEstadosActivos).toEqual(["pendiente", "confirmado"]);
    expect(TurnoEstadosActivos).toSatisfy((estados: readonly string[]) =>
      estados.every((e) => Object.values(TurnoEstado).includes(e as TurnoEstado)),
    );
  });
});