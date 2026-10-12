import { Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Gestion } from "./pages/Gestion";
import { GestionAgenda } from "./pages/GestionAgenda";
import { Historial } from "./pages/Historial";
import { Login } from "./pages/Login";
import { Metricas } from "./pages/Metricas";
import { Panel } from "./pages/Panel";
import { Reservar } from "./pages/Reservar";

/**
 * Rutas de la SPA: navegación MIXTA público/negocio.
 *
 * - Público: `/` y `/reservar` (flujo de reserva), `/g/:token` (gestión por
 *   enlace).
 * - Negocio (auth-gated): `/login` y `/panel/*` — el shell `Panel` verifica la
 *   sesión (GET /auth/me) y redirige a /login sin cookie válida (VNG-S7).
 */
export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Reservar />} />
        <Route path="reservar" element={<Reservar />} />
        <Route path="g/:token" element={<Gestion />} />
        <Route path="login" element={<Login />} />
        <Route path="panel" element={<Panel />}>
          <Route index element={<Dashboard />} />
          <Route path="historial" element={<Historial />} />
          <Route path="metricas" element={<Metricas />} />
          <Route path="agenda" element={<GestionAgenda />} />
        </Route>
      </Route>
    </Routes>
  );
}
