import { Pool } from "pg";

/**
 * Conexión PostgreSQL (pg). T-05 agrega Drizzle sobre este pool; acá se
 * mantiene el mínimo necesario para el chequeo de salud (SELECT 1).
 */

export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 2000,
  });
}

export type CheckDb = () => Promise<boolean>;

/** Chequeo de salud de la BD: responde `true` si `SELECT 1` tiene éxito. */
export function createCheckDb(databaseUrl: string): CheckDb {
  const pool = createPool(databaseUrl);
  return async () => {
    try {
      await pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  };
}