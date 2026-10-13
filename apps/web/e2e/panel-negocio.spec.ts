import { test } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";
import { PanelPage } from "./pages/PanelPage";

/**
 * Panel del negocio (T-24, T-17): login del operador → vista del día.
 *
 * El operador demo lo crea el seed idempotente con las credenciales del entorno
 * (OPERADOR_EMAIL / OPERADOR_PASSWORD; ver .env.example).
 */
const OPERADOR_EMAIL = process.env.OPERADOR_EMAIL ?? "operador@demo.local";
const OPERADOR_PASSWORD = process.env.OPERADOR_PASSWORD ?? "demo-password-123";

test("login → vista del día del negocio", async ({ page }) => {
  const login = new LoginPage(page);
  await login.abrir();
  await login.ingresar(OPERADOR_EMAIL, OPERADOR_PASSWORD);

  const panel = new PanelPage(page);
  await panel.esperarPanel();
  await panel.esperarVistaDelDia();
});
