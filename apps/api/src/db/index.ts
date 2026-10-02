import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Conexión PostgreSQL + cliente Drizzle. El pool se crea perezosamente en
 * cada `createDb` (v1: una instancia por proceso).
 */

export type Database = NodePgDatabase<typeof schema>;

export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 2000,
  });
}

export function createDb(databaseUrl: string): Database {
  return drizzle(createPool(databaseUrl), { schema });
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