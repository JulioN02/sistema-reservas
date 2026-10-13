import { expect, type Page } from "@playwright/test";

/** Page Object del login del operador (`/login`, T-17/VNG-S1). */
export class LoginPage {
  constructor(private readonly page: Page) {}

  async abrir(): Promise<void> {
    await this.page.goto("/login");
    await expect(
      this.page.getByRole("heading", { name: "Iniciar sesión" }),
    ).toBeVisible();
  }

  async ingresar(email: string, password: string): Promise<void> {
    await this.page.getByLabel("Email").fill(email);
    await this.page.getByLabel("Contraseña").fill(password);
    await this.page.getByRole("button", { name: "Ingresar" }).click();
  }
}
