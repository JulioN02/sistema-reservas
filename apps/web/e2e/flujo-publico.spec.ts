import { expect, test } from "@playwright/test";
import { GestionPage } from "./pages/GestionPage";
import { ReservaPage } from "./pages/ReservaPage";

/**
 * Slice vertical #1 (T-24): reserva → confirmación por enlace → cancelación.
 *
 * Cubre el camino feliz de RST (crear), CMR (confirmar por enlace) y CRG
 * (cancelar dentro de gracia) sobre el stack completo.
 */
test.describe("Flujo público: reserva → confirmación → cancelación", () => {
  test("reserva, confirma por enlace y cancela", async ({ page }) => {
    const reserva = new ReservaPage(page);
    await reserva.abrir();
    await reserva.elegirPrimerServicio();
    // Slot lejano → DENTRO de la ventana de gracia (inicio − ahora ≥ graciaMin)
    // → la cancelación procede sin 403.
    await reserva.elegirSlotMasLejano();
    await reserva.completarDatos({
      nombre: "Ana Cliente",
      email: "ana.cliente@example.com",
    });
    await reserva.confirmarReserva();

    const token = await reserva.tokenDeGestion();

    const gestion = new GestionPage(page);
    await gestion.abrir(token);
    await expect(page.getByText("pendiente", { exact: true })).toBeVisible();

    await gestion.confirmar();
    await gestion.cancelar();
  });
});
