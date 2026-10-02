import { Route, Routes } from "react-router";
import { Layout } from "./components/Layout";

function Inicio() {
  return (
    <section>
      <h1>Sistema de Reservas</h1>
      <p>
        Reserve su turno en línea: elija un servicio, seleccione el horario y
        confirme con un solo toque.
      </p>
      <p>
        <a href="/reservar">Reservar un turno</a>
      </p>
    </section>
  );
}

/** Placeholder del flujo público de reserva (implementación en T-13). */
function Reservar() {
  return <section aria-label="Reserva de turno"><h2>Reservar turno</h2><p>El flujo de reserva estará disponible próximamente.</p></section>;
}

/** Placeholder de la página de gestión por enlace (implementación en T-13). */
function Gestion() {
  return <section aria-label="Gestión de turno"><h2>Gestión de turno</h2><p>La página de gestión del enlace estará disponible próximamente.</p></section>;
}

/** Placeholder del panel del negocio (implementación en T-17). */
function Panel() {
  return <section aria-label="Panel del negocio"><h2>Panel del negocio</h2><p>El panel de gestión estará disponible próximamente.</p></section>;
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Inicio />} />
        <Route path="reservar" element={<Reservar />} />
        <Route path="g/:token" element={<Gestion />} />
        <Route path="panel" element={<Panel />} />
      </Route>
    </Routes>
  );
}