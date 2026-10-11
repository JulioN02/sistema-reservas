import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { Database } from "../db";
import type {
  CredencialesLogin,
  OperadorSesion,
  SesionActiva,
} from "../dto/auth";
import { authRepository } from "../repositories/authRepository";

/**
 * AuthService (T-07) — lógica pura de sesiones opacas (A8, RB-VNG-05),
 * sin dependencias de framework:
 *
 * - login: email + password verificado con argon2id; sesión con token opaco
 *   de 32 bytes (base64url) cuyo sha256 se guarda en `sesiones.token_hash`.
 * - TTL de la sesión: configurable (env SESSION_TTL_DAYS, default 7 días).
 * - logout: revoca vía `revoked_at` (idempotente).
 * - sesionPorToken: resuelve la sesión activa para el middleware de rutas
 *   negocio (401 sin cookie válida — VNG-S7).
 */

export interface LoginOpciones {
  tenantId: string;
  ttlDays: number;
  /** Inyectable para tests deterministas; default `new Date()`. */
  ahora?: Date;
}

export interface LoginResultado {
  operador: OperadorSesion;
  /** Token opaco que viaja en la cookie `sid` (única vez en claro). */
  token: string;
}

/** Token opaco: 32 bytes aleatorios (≥128 bits) en base64url. */
export function generarTokenOpaco(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256 hex del token: la BD nunca guarda el token en claro. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function verificarPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    // Hash malformado o algoritmo desconocido → credencial inválida.
    return false;
  }
}

export const authService = {
  /**
   * Valida credenciales y crea una sesión. Devuelve `null` si las
   * credenciales no son válidas (mismo resultado para email inexistente y
   * password incorrecto: 401 sin revelar cuál falló).
   */
  async login(
    db: Database,
    credenciales: CredencialesLogin,
    opciones: LoginOpciones,
  ): Promise<LoginResultado | null> {
    const ahora = opciones.ahora ?? new Date();
    const operador = await authRepository.porEmail(
      db,
      opciones.tenantId,
      credenciales.email,
    );
    if (operador === undefined) return null;

    const esValida = await verificarPassword(
      operador.password_hash,
      credenciales.password,
    );
    if (!esValida) return null;

    const token = generarTokenOpaco();
    const expiresAt = new Date(
      ahora.getTime() + opciones.ttlDays * 24 * 60 * 60 * 1000,
    );
    await authRepository.crearSesion(db, {
      operador_id: operador.id,
      tenant_id: operador.tenant_id,
      token_hash: hashToken(token),
      expires_at: expiresAt,
    });

    return {
      operador: {
        operador_id: operador.id,
        email: operador.email,
        nombre: operador.nombre,
      },
      token,
    };
  },

  /** Resuelve la sesión activa del token (no revocada, dentro de TTL). */
  async sesionPorToken(
    db: Database,
    token: string,
    ahora?: Date,
  ): Promise<SesionActiva | null> {
    const fila = await authRepository.sesionActivaPorTokenHash(
      db,
      hashToken(token),
      ahora ?? new Date(),
    );
    if (fila === undefined) return null;
    return {
      sesion_id: fila.sesion_id,
      tenant_id: fila.tenant_id,
      operador: {
        operador_id: fila.operador_id,
        email: fila.email,
        nombre: fila.nombre,
      },
    };
  },

  /** Revoca la sesión; `false` si ya estaba revocada o no existía. */
  async logout(db: Database, token: string, ahora?: Date): Promise<boolean> {
    return authRepository.revocarPorTokenHash(
      db,
      hashToken(token),
      ahora ?? new Date(),
    );
  },
};