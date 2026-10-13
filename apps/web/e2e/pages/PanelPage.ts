import { expect, type Page } from "@playwright/test";

/** Page Object del panel del negocio auth-gated (`/panel/*`, T-17/VNG-S3). */
export class PanelPage {
  constructor(private readonly page: Page) {}

  async esperarPanel(): Promise<void> {
    await expect(
      this.page.getByRole("heading", { name: "Panel del negocio" }),
    ).toBeVisible();
  }

  /** Vista del día: encabezado + selector de fecha (RB-VNG-01). */
  async esperarVistaDelDia(): Promise<void> {
    await expect(
      this.page.getByRole("heading", { name: "Vista del día" }),
    ).toBeVisible();
    await expect(this.page.getByLabel("Fecha")).toBeVisible();
  }

  /** Navega entre secciones del panel. */
  async irA(seccion: "Día" | "Historial" | "Métricas" | "Agenda"): Promise<void> {
    await this.page
      .getByRole("link", { name: seccion, exact: true })
      .click();
  }
}
