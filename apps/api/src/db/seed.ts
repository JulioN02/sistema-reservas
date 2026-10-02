import argon2 from "argon2";
import { and, eq } from "drizzle-orm";
import { parseEnv } from "../config/env";
import { createDb } from "./index";
import {
  horariosRecurrentes,
  operadores,
  servicios,
  tenants,
} from "./schema";

/**
 * Seed idempotente (INT-S2, RB-INT-04): crea el tenant demo del README, su
 * operador (credenciales vía entorno) y los servicios/horarios base.
 *
 * Idempotencia: cada entidad se inserta solo si no existe (upsert por clave
 * natural). Puede ejecutarse N veces sin duplicar datos.
 *
 * Variables de entorno:
 * - OPERADOR_EMAIL   (default: operador@demo.local)
 * - OPERADOR_PASSWORD (default: demo-password-123 — SOLO desarrollo)
 *
 * Uso: pnpm --filter api db:seed   (requiere DATABASE_URL)
 */

export interface SeedResult {
  tenant_id: string;
  tenant_slug: string;
  operador_email: string;
  servicios: number;
  horarios: number;
}

export async function seedDatabase(databaseUrl: string): Promise<SeedResult> {
  const db = createDb(databaseUrl);
  const env = parseEnv({ ...process.env, DATABASE_URL: databaseUrl });

  const operadorEmail =
    process.env.OPERADOR_EMAIL ?? "operador@demo.local";
  const operadorPassword =
    process.env.OPERADOR_PASSWORD ?? "demo-password-123";
  const passwordHash = await argon2.hash(operadorPassword, {
    type: argon2.argon2id,
  });

  // 1. Tenant demo (negocio del README).
  const slug = env.DEFAULT_TENANT_SLUG;
  let tenant =
    (await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) })) ??
    null;
  if (tenant === null) {
    const insertado = await db
      .insert(tenants)
      .values({
        slug,
        nombre: "Negocio Demo",
        timezone: "America/Argentina/Buenos_Aires",
        email_contacto: "contacto@demo.local",
        telefono_contacto: "+54 11 5555-0100",
      })
      .returning();
    tenant = insertado[0] ?? null;
  }
  if (tenant === null) {
    throw new Error("No se pudo crear ni recuperar el tenant demo.");
  }

  // 2. Operador (uno por tenant — RB-VNG-06).
  const operadorExistente = await db.query.operadores.findFirst({
    where: (t) => eq(t.email, operadorEmail),
  });
  if (operadorExistente === undefined) {
    await db.insert(operadores).values({
      tenant_id: tenant.id,
      email: operadorEmail,
      password_hash: passwordHash,
      nombre: "Operador Demo",
    });
  }

  // 3. Servicios base.
  const serviciosDemo = [
    { nombre: "Consulta general", duracion_min: 30, precio: "25.00" },
    { nombre: "Sesión de 45 minutos", duracion_min: 45, precio: "35.00" },
    { nombre: "Sesión de 60 minutos", duracion_min: 60, precio: "45.00" },
  ] as const;
  let serviciosCreados = 0;
  for (const s of serviciosDemo) {
    const existente = await db.query.servicios.findFirst({
      where: (t) =>
        and(eq(t.tenant_id, tenant.id), eq(t.nombre, s.nombre)),
    });
    if (existente === undefined) {
      await db.insert(servicios).values({
        tenant_id: tenant.id,
        nombre: s.nombre,
        duracion_min: s.duracion_min,
        precio: s.precio,
        booking_window_days: 30,
        cancellation_grace_minutes: 180,
        activo: true,
      });
      serviciosCreados += 1;
    }
  }

  // 4. Horarios recurrentes: lun–vie 09:00–18:00, sáb 09:00–13:00.
  const horariosDemo = [
    { dia_semana: 1, hora_inicio: "09:00:00", hora_fin: "18:00:00" },
    { dia_semana: 2, hora_inicio: "09:00:00", hora_fin: "18:00:00" },
    { dia_semana: 3, hora_inicio: "09:00:00", hora_fin: "18:00:00" },
    { dia_semana: 4, hora_inicio: "09:00:00", hora_fin: "18:00:00" },
    { dia_semana: 5, hora_inicio: "09:00:00", hora_fin: "18:00:00" },
    { dia_semana: 6, hora_inicio: "09:00:00", hora_fin: "13:00:00" },
  ] as const;
  let horariosCreados = 0;
  for (const h of horariosDemo) {
    const existente = await db.query.horariosRecurrentes.findFirst({
      where: (t) =>
        and(
          eq(t.tenant_id, tenant.id),
          eq(t.dia_semana, h.dia_semana),
          eq(t.hora_inicio, h.hora_inicio),
        ),
    });
    if (existente === undefined) {
      await db.insert(horariosRecurrentes).values({
        tenant_id: tenant.id,
        ...h,
        timezone: tenant.timezone,
      });
      horariosCreados += 1;
    }
  }

  return {
    tenant_id: tenant.id,
    tenant_slug: slug,
    operador_email: operadorEmail,
    servicios: serviciosCreados,
    horarios: horariosCreados,
  };
}

// Ejecución directa: pnpm --filter api db:seed
import { pathToFileURL } from "node:url";

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  const env = parseEnv();
  seedDatabase(env.DATABASE_URL)
    .then((r) => {
      console.log(
        `Seed OK — tenant '${r.tenant_slug}' (${r.tenant_id}), operador '${r.operador_email}', +${r.servicios} servicios, +${r.horarios} horarios`,
      );
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error("Seed falló:", error);
      process.exit(1);
    });
}