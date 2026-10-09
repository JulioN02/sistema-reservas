import { Link, Outlet } from "react-router";

/**
 * Layout base de la SPA: cabecera con navegación, contenido y pie.
 * Textos en español neutro.
 */
export function Layout() {
  return (
    <div className="layout">
      <header className="cabecera">
        <Link to="/" className="marca">
          Sistema de Reservas
        </Link>
        <nav className="navegacion" aria-label="Navegación principal">
          <Link to="/reservar">Reservar</Link>
          <Link to="/panel">Panel del negocio</Link>
        </nav>
      </header>
      <main className="contenido">
        <Outlet />
      </main>
      <footer className="pie">
        <p>Sistema de Reservas — microproducto de arranque</p>
      </footer>
    </div>
  );
}