import { expect, type Page } from "@playwright/test";

/**
 * Page Object del flujo público de reserva (T-13, RF-01..RF-05).
 *
 * Selectores por rol/etiqueta (accesibilidad) — ver playwright skill.
 */
export class ReservaPage {
  constructor(private readonly page: Page) {}

  async abrir(): Promise<void> {
    await this.page.goto("/reservar");
    await expect(
      this.page.getByRole("heading", { name: "Reservar turno" }),
    ).toBeVisible();
  }

  /** Paso 1: elige el primer servicio ofrecido y avanza a los horarios. */
  async elegirPrimerServicio(): Promise<void> {
    await expect(
      this.page.getByRole("heading", { name: "Elige un servicio" }),
    ).toBeVisible();
    // El nombre accesible de cada servicio termina en "<n> min".
    await this.page.getByRole("button", { name: /min$/ }).first().click();
    await expect(
      this.page.getByRole("heading", { name: "Elige un horario" }),
    ).toBeVisible();
  }

  /**
   * Paso 2: elige el ÚLTIMO slot ofrecido (el más lejano en la ventana de
   * reserva). Queda holgadamente fuera de la ventana de gracia de cancelación,
   * de modo que el flujo de cancelación por enlace no reciba un 403.
   */
  async elegirSlotMasLejano(): Promise<void> {
    const slots = this.page.getByRole("button", { name: /^\d{2}:\d{2}$/ });
    await expect(slots.first()).toBeVisible();
    await slots.last().click();
    await expect(
      this.page.getByRole("heading", { name: "Tus datos" }),
    ).toBeVisible();
  }

  /**
   * Paso 2 (variante): elige el PRIMER slot ofrecido (el más cercano). Sirve a
   * los flujos que solo confirman (no cancelan), evitando competir por el slot
   * del flujo de cancelación.
   */
  async elegirSlotMasCercano(): Promise<void> {
    const slots = this.page.getByRole("button", { name: /^\d{2}:\d{2}$/ });
    await expect(slots.first()).toBeVisible();
    await slots.first().click();
    await expect(
      this.page.getByRole("heading", { name: "Tus datos" }),
    ).toBeVisible();
  }

  /** Paso 3: contacto + consentimiento obligatorio (PRV-01). */
  async completarDatos(datos: {
    nombre: string;
    email?: string;
    telefono?: string;
  }): Promise<void> {
    await this.page.getByLabel("Nombre").fill(datos.nombre);
    if (datos.email !== undefined) {
      await this.page.getByLabel("Email (opcional)").fill(datos.email);
    }
    if (datos.telefono !== undefined) {
      await this.page.getByLabel("Teléfono (opcional)").fill(datos.telefono);
    }
    await this.page.getByLabel(/Acepto el consentimiento/).check();
  }

  async confirmarReserva(): Promise<void> {
    await this.page
      .getByRole("button", { name: "Confirmar reserva" })
      .click();
    await expect(
      this.page.getByRole("heading", { name: "Reserva confirmada" }),
    ).toBeVisible();
  }

  /** Extrae el token de gestión del enlace absoluto de la pantalla de éxito. */
  async tokenDeGestion(): Promise<string> {
    const enlace = this.page.getByRole("link", { name: "Gestionar mi turno" });
    const href = await enlace.getAttribute("href");
    if (href === null) throw new Error("El enlace de gestión no tiene href.");
    const token = new URL(href, this.page.url()).pathname
      .split("/")
      .filter(Boolean)
      .pop();
    if (token === undefined) {
      throw new Error("No se pudo extraer el token de gestión del enlace.");
    }
    return token;
  }
}
