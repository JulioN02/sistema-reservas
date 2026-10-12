import { useActionState } from "react";
import { useNavigate } from "react-router";
import type { ErrorCampo } from "../lib/apiClient";
import { ApiError, apiClient, erroresDeCampo } from "../lib/apiClient";

/**
 * Login del operador del negocio (VNG-04, VNG-S1/S2): email + password →
 * POST /auth/login (cookie de sesión opaca). Éxito → /panel.
 * Errores: 401 credenciales inválidas · 429 bloqueo 15 min · 422 por campo.
 */

interface ResultadoLogin {
  mensaje: string;
  errores: ErrorCampo[];
}

const RESULTADO_INICIAL: ResultadoLogin = { mensaje: "", errores: [] };

export function Login() {
  const navigate = useNavigate();

  async function entrar(
    _previo: ResultadoLogin,
    formData: FormData,
  ): Promise<ResultadoLogin> {
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");

    try {
      await apiClient.login({ email, password });
      navigate("/panel");
      return RESULTADO_INICIAL;
    } catch (fallo: unknown) {
      if (fallo instanceof ApiError) {
        if (fallo.status === 422) {
          return {
            mensaje: fallo.problem.detail,
            errores: erroresDeCampo(fallo),
          };
        }
        // 401 (credenciales inválidas) y 429 (lockout) muestran el detail.
        return { mensaje: fallo.problem.detail, errores: [] };
      }
      return {
        mensaje: "No se pudo iniciar sesión. Intenta nuevamente.",
        errores: [],
      };
    }
  }

  const [resultado, formAction, pendiente] = useActionState(
    entrar,
    RESULTADO_INICIAL,
  );

  return (
    <section aria-label="Iniciar sesión" className="login">
      <h2>Iniciar sesión</h2>

      {resultado.mensaje !== "" ? (
        <p role="alert" className="login__error">
          {resultado.mensaje}
        </p>
      ) : null}

      {resultado.errores.length > 0 ? (
        <ul className="errores-campo">
          {resultado.errores.map((error) => (
            <li key={error.campo}>
              {error.campo}: {error.mensaje}
            </li>
          ))}
        </ul>
      ) : null}

      <form action={formAction} className="login__form">
        <div className="login__campo">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            aria-required="true"
          />
        </div>
        <div className="login__campo">
          <label htmlFor="password">Contraseña</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            aria-required="true"
          />
        </div>
        <button type="submit" disabled={pendiente}>
          {pendiente ? "Ingresando…" : "Ingresar"}
        </button>
      </form>
    </section>
  );
}
