import { expect, type Page } from "@playwright/test";

/**
 * Page Object de la gestión por enlace (`/g/{token}`, T-13/T-11/T-14):
 * confirmar y cancelar el turno desde el enlace público.
 */
export class GestionPage {
  constructor(private readonly page: Page) {}

  async abrir(token: string): Promise<void> {
    await this.page.goto(`/g/${token}`);
    await expect(
      this.page.getByRole("heading", { name: "Gestión de turno" }),
    ).toBeVisible();
    // Espera a que la tarjeta del turno termine de cargar.
    await expect(this.page.getByText("Cargando tu turno…")).toBeHidden();
  }

  /** Confirmación idempotente por enlace (CMR, CA-CMR-01/04). */
  async confirmar(): Promise<void> {
    await this.page
      .getByRole("button", { name: "Confirmar", exact: true })
      .click();
    await expect(this.page.getByText("Turno confirmado.")).toBeVisible();
    await expect(this.page.getByText("confirmado", { exact: true })).toBeVisible();
  }

  /** Cancelación dentro de gracia por enlace (CRG, RF-13). */
  async cancelar(): Promise<void> {
    await this.page
      .getByRole("button", { name: "Cancelar", exact: true })
      .click();
    await expect(this.page.getByText("Turno cancelado.")).toBeVisible();
    await expect(this.page.getByText("cancelado", { exact: true })).toBeVisible();
  }
}
