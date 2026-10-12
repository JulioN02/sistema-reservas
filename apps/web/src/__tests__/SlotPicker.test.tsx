import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SlotPicker } from "../components/SlotPicker";
import type { DiaAgenda } from "../lib/apiClient";

const ZONA = "America/Argentina/Buenos_Aires";

const DIAS: DiaAgenda[] = [
  {
    fecha: "2026-10-05",
    slots: [
      {
        slot_key: "2026-10-05T09:00:00.000Z|svc-1",
        fecha_hora_inicio: "2026-10-05T09:00:00.000Z",
        fecha_hora_fin: "2026-10-05T09:30:00.000Z",
      },
      {
        slot_key: "2026-10-05T09:30:00.000Z|svc-1",
        fecha_hora_inicio: "2026-10-05T09:30:00.000Z",
        fecha_hora_fin: "2026-10-05T10:00:00.000Z",
      },
    ],
  },
  { fecha: "2026-10-06", slots: [] },
];

describe("SlotPicker — agenda por día", () => {
  it("muestra cada día con sus horarios en hora local del negocio", () => {
    render(
      <SlotPicker
        dias={DIAS}
        zonaHoraria={ZONA}
        seleccionado={null}
        onSeleccionar={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: /lunes/i }),
    ).toBeInTheDocument();
    // 09:00 UTC → 06:00 y 09:30 UTC → 06:30 en Buenos Aires.
    expect(screen.getByRole("button", { name: "06:00" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "06:30" })).toBeInTheDocument();
  });

  it("señala los días sin horarios con un estado accesible", () => {
    render(
      <SlotPicker
        dias={DIAS}
        zonaHoraria={ZONA}
        seleccionado={null}
        onSeleccionar={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      /sin horarios disponibles/i,
    );
  });

  it("marca el slot seleccionado con aria-current y lo notifica al elegir", () => {
    const onSeleccionar = vi.fn();
    render(
      <SlotPicker
        dias={DIAS}
        zonaHoraria={ZONA}
        seleccionado={"2026-10-05T09:00:00.000Z|svc-1"}
        onSeleccionar={onSeleccionar}
      />,
    );

    const seleccionado = screen.getByRole("button", { name: "06:00" });
    expect(seleccionado).toHaveAttribute("aria-current", "true");
    expect(seleccionado).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "06:30" }));
    expect(onSeleccionar).toHaveBeenCalledTimes(1);
    expect(onSeleccionar).toHaveBeenCalledWith(DIAS[0]?.slots[1]);
  });
});
