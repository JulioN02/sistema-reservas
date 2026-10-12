import { createContext, useContext } from "react";
import type { ReactNode } from "react";

/**
 * Contexto del panel del negocio: datos de sesión que necesitan las páginas
 * hijas (zona horaria del tenant para presentar horas locales — RB-VNG-01).
 */
export interface PanelContexto {
  /** Zona horaria IANA del negocio (de /auth/me). */
  zonaHoraria: string;
  /** Nombre del operador para la cabecera del panel. */
  operadorNombre: string;
}

const PanelContext = createContext<PanelContexto | null>(null);

export function PanelProvider({
  value,
  children,
}: {
  value: PanelContexto;
  children: ReactNode;
}) {
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

/** Accede al contexto del panel; falla si se usa fuera del provider. */
export function usePanel(): PanelContexto {
  const contexto = useContext(PanelContext);
  if (contexto === null) {
    throw new Error("usePanel debe usarse dentro de un PanelProvider.");
  }
  return contexto;
}
