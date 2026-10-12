import { Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { Gestion } from "./pages/Gestion";
import { Reservar } from "./pages/Reservar";

/** Placeholder del panel del negocio (implementación en T-17). */
function Panel() {
  return (
    <section aria-label="Panel del negocio">
      <h2>Panel del negocio</h2>
      <p>El panel de gestión estará disponible próximamente.</p>
    </section>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Reservar />} />
        <Route path="reservar" element={<Reservar />} />
        <Route path="g/:token" element={<Gestion />} />
        <Route path="panel" element={<Panel />} />
      </Route>
    </Routes>
  );
}
