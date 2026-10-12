import { useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useNavigate } from "react-router";
import { PanelProvider } from "../components/PanelContext";
import type { OperadorSesion } from "../lib/apiClient";
import { apiClient, esNoAutorizado, mensajeDeError } from "../lib/apiClient";

/**
 * Shell del panel del negocio (T-17, VNG-S7): verifica la sesión con
 * GET /auth/me al montar. Sin sesión → redirige a /login. Con sesión, expone
 * la zona horaria del tenant (contexto) y la navegación Día · Historial ·
 * Métricas · Agenda + cerrar sesión (POST /auth/logout).
 */

export function Panel() {
  const navigate = useNavigate();
  const [sesion, setSesion] = useState<OperadorSesion | null>(null);
  const [noAutorizado, setNoAutorizado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    let activo = true;
    setCargando(true);
    apiClient
      .operadorActual()
      .then((operador) => {
        if (!activo) return;
        setSesion(operador);
        setCargando(false);
      })
      .catch((fallo: unknown) => {
        if (!activo) return;
        if (esNoAutorizado(fallo)) {
          setNoAutorizado(true);
          return;
        }
        setError(mensajeDeError(fallo));
        setCargando(false);
      });
    return () => {
      activo = false;
    };
  }, []);

  async function cerrarSesion() {
    try {
      await apiClient.logout();
    } catch {
      // Aunque el logout falle, se cierra la sesión en la UI.
    }
    navigate("/login");
  }

  if (noAutorizado) return <Navigate to="/login" replace />;

  if (cargando) {
    return (
      <section aria-label="Panel del negocio">
        <p role="status">Cargando panel…</p>
      </section>
    );
  }

  if (sesion === null) {
    return (
      <section aria-label="Panel del negocio">
        <p role="alert">{error ?? "No se pudo cargar el panel."}</p>
      </section>
    );
  }

  return (
    <PanelProvider
      value={{ zonaHoraria: sesion.timezone, operadorNombre: sesion.nombre }}
    >
      <section aria-label="Panel del negocio" className="panel">
        <header className="panel__cabecera">
          <h2>Panel del negocio</h2>
          <span className="panel__operador">{sesion.nombre}</span>
          <button type="button" onClick={() => void cerrarSesion()}>
            Cerrar sesión
          </button>
        </header>

        <nav className="panel__navegacion" aria-label="Secciones del panel">
          <NavLink to="/panel" end>
            Día
          </NavLink>
          <NavLink to="/panel/historial">Historial</NavLink>
          <NavLink to="/panel/metricas">Métricas</NavLink>
          <NavLink to="/panel/agenda">Agenda</NavLink>
        </nav>

        <Outlet />
      </section>
    </PanelProvider>
  );
}
