import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const aqui = dirname(fileURLToPath(import.meta.url));
const spec = parse(readFileSync(join(aqui, "..", "openapi.yaml"), "utf8"));

/**
 * Inventario del diseño §4.2 — cada path/método del diseño debe existir en el
 * contrato con los códigos de respuesta documentados. Es la base del test de
 * conformancia completo (T-21).
 */
const inventario: Record<string, { metodos: Record<string, number[]> }> = {
  "/servicios": { metodos: { get: [200, 401, 500] } },
  "/agenda": { metodos: { get: [200, 400, 422, 500] } },
  "/turnos": {
    metodos: {
      post: [201, 400, 409, 422, 500],
      get: [200, 401, 422, 500],
    },
  },
  "/turnos/{token}": { metodos: { get: [200, 404, 410, 500] } },
  "/turnos/{token}/confirmar": { metodos: { post: [200, 404, 410, 500] } },
  "/turnos/{token}/cancelar": {
    metodos: { post: [200, 403, 404, 409, 410, 500] },
  },
  "/turnos/{token}/reagendar": {
    metodos: { post: [200, 403, 404, 409, 410, 422, 500] },
  },
  "/turnos/{id}": { metodos: { get: [200, 401, 404, 500] } },
  "/turnos/{id}/acciones": {
    metodos: { post: [200, 400, 401, 404, 409, 422, 500] },
  },
  "/auth/login": { metodos: { post: [200, 401, 422, 429, 500] } },
  "/auth/logout": { metodos: { post: [204, 401, 500] } },
  "/auth/me": { metodos: { get: [200, 401, 500] } },
  "/agenda/horarios": {
    metodos: { get: [200, 401, 500], post: [201, 401, 409, 422, 500] },
  },
  "/agenda/horarios/{id}": {
    metodos: { put: [200, 401, 404, 422, 500], delete: [204, 401, 404, 500] },
  },
  "/agenda/bloques": {
    metodos: { get: [200, 401, 500], post: [201, 401, 409, 422, 500] },
  },
  "/agenda/bloques/{id}": { metodos: { delete: [204, 401, 404, 500] } },
  "/agenda/dia": { metodos: { get: [200, 400, 401, 422, 500] } },
  "/servicios/{id}": {
    metodos: { put: [200, 401, 404, 409, 422, 500], delete: [204, 401, 404, 409, 500] },
  },
  "/servicios/{id}/parametros": {
    metodos: { patch: [200, 401, 404, 422, 500] },
  },
  "/metricas/resumen": { metodos: { get: [200, 401, 500] } },
  "/health": { metodos: { get: [200, 500] } },
};

describe("openapi.yaml — conformancia con el diseño §4.2", () => {
  it("es OpenAPI 3.1", () => {
    expect(spec.openapi).toBe("3.1.0");
  });

  it("todos los paths del diseño §4.2 están presentes", () => {
    for (const path of Object.keys(inventario)) {
      expect(spec.paths, `path faltante: ${path}`).toHaveProperty(path);
    }
  });

  it("todos los métodos y códigos del diseño §4.2 están documentados", () => {
    for (const [path, { metodos }] of Object.entries(inventario)) {
      for (const [metodo, codigos] of Object.entries(metodos)) {
        const operacion = spec.paths[path]?.[metodo];
        expect(
          operacion,
          `operación faltante: ${metodo.toUpperCase()} ${path}`,
        ).toBeDefined();
        for (const codigo of codigos) {
          expect(
            operacion.responses[String(codigo)],
            `respuesta faltante: ${metodo.toUpperCase()} ${path} → ${codigo}`,
          ).toBeDefined();
        }
      }
    }
  });

  it("los 5 enums del diseño §3.2 están definidos con los valores exactos", () => {
    const esperados: Record<string, string[]> = {
      TurnoEstado: ["pendiente", "confirmado", "completado", "cancelado", "no_show"],
      RecordatorioCanal: ["email", "log"],
      RecordatorioEstado: ["programado", "enviado", "fallido", "cancelado"],
      EventoTipo: [
        "reserva_creada",
        "reserva_confirmada",
        "cancelacion",
        "reagendulacion",
        "recordatorio_enviado",
        "recordatorio_fallido",
        "completado",
        "no_show",
      ],
      EventoOrigen: ["public", "business", "system"],
    };
    for (const [nombre, valores] of Object.entries(esperados)) {
      expect(spec.components.schemas[nombre]?.enum).toEqual(valores);
    }
  });

  it("los errores usan el esquema RFC 7807 (problem+json)", () => {
    const error = spec.components.schemas.Error;
    expect(error.required).toContain("type");
    expect(error.required).toContain("status");
    expect(error.properties.type.format).toBe("uri");
    expect(error.properties.errores).toBeDefined();
    expect(error.properties.alternativas).toBeDefined();
  });

  it("los type URI de problem+json usan el dominio base acordado", () => {
    // El dominio base acordado: https://sistema-reservas.example.com/problems
    expect(spec.components.schemas.Error.properties.type.example).toMatch(
      /^https:\/\/sistema-reservas\.example\.com\/problems\//,
    );
  });

  it("consentimiento es obligatorio y debe ser true (PRV-01)", () => {
    const turnoCrear = spec.components.schemas.TurnoCrearInput;
    expect(turnoCrear.required).toContain("consentimiento");
    expect(turnoCrear.properties.consentimiento.const).toBe(true);
  });

  it("ningún endpoint público declara tenant_id en sus respuestas (CA-INT-04)", () => {
    const schemasPublicos = [
      "ServicioPublico",
      "Slot",
      "DiaAgenda",
      "AgendaResponse",
      "TurnoCreado",
      "TurnoGestion",
      "TurnoAccionResultado",
    ];
    for (const nombre of schemasPublicos) {
      const props = spec.components.schemas[nombre]?.properties;
      const allOfProps = spec.components.schemas[nombre]?.allOf;
      expect(
        props ?? allOfProps,
        `${nombre} debería exponer propiedades`,
      ).toBeDefined();
    }
    const sinTenantId = (schema: Record<string, unknown>): boolean => {
      const props = schema.properties;
      return !(
        typeof props === "object" &&
        props !== null &&
        "tenant_id" in props
      );
    };
    for (const nombre of schemasPublicos) {
      const schema = spec.components.schemas[nombre];
      if (schema.allOf) {
        for (const parte of schema.allOf) {
          expect(sinTenantId(parte), `${nombre} no debe exponer tenant_id`).toBe(
            true,
          );
        }
      } else {
        expect(
          sinTenantId(schema),
          `${nombre} no debe exponer tenant_id`,
        ).toBe(true);
      }
    }
  });
});