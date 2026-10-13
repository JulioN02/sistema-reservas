import { expect, test } from "@playwright/test";
import { GestionPage } from "./pages/GestionPage";
import { ReservaPage } from "./pages/ReservaPage";

/**
 * CA-CMR-04: el enlace de gestión opera SIN depender del email (fallback).
 *
 * El stack de E2E corre con `NOTIFICATION_CHANNEL=log` (LogChannel, sin
 * RESEND_API_KEY). Reservamos con SOLO teléfono (sin email) y aun así
 * confirmamos por el enlace de gestión: demuestra que el enlace firmado es un
 * canal independiente del email.
 */
test("reserva sin email (LogChannel): el enlace de gestión funciona", async ({
  page,
}) => {
  const reserva = new ReservaPage(page);
  await reserva.abrir();
  await reserva.elegirPrimerServicio();
  // Solo confirma (no cancela) → puede usar el slot más cercano.
  await reserva.elegirSlotMasCercano();
  await reserva.completarDatos({
    nombre: "Bruno SinCorreo",
    telefono: "+54 11 5555-0199",
  });
  await reserva.confirmarReserva();

  const token = await reserva.tokenDeGestion();

  const gestion = new GestionPage(page);
  await gestion.abrir(token);
  await expect(page.getByText("Bruno SinCorreo")).toBeVisible();
  await gestion.confirmar();
});
