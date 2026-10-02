import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

/**
 * Mínimo común de logger requerido por el manejador de errores: compatible
 * con `FastifyBaseLogger` (app.log) y con pino `Logger`.
 */
export interface ErrorLogger {
  error(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Errores de dominio → RFC 7807 (application/problem+json).
 *
 * El manejador central mapea excepciones de dominio a problem+json sin
 * filtrar internals: 500 genérico + log estructurado con request_id.
 *
 * Convenciones del contrato (openapi.yaml):
 * - `errores[]` solo en 422 (validación por campo).
 * - `alternativas[]` solo en 409 (hasta 3 slot_keys).
 * - `type` URI con dominio base `https://sistema-reservas.example.com/problems`
 *   (placeholder de despliegue, acordado en T-02).
 */

export const PROBLEM_BASE_URI =
  "https://sistema-reservas.example.com/problems";

export type ErrorCampo = { campo: string; mensaje: string };

export interface ProblemJson {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  errores?: ErrorCampo[];
  alternativas?: string[];
}

interface AppErrorOptions {
  status: number;
  code: string;
  title: string;
  detail: string;
  errores?: ErrorCampo[];
  alternativas?: string[];
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly errores?: ErrorCampo[];
  readonly alternativas?: string[];

  constructor(opts: AppErrorOptions) {
    super(opts.title);
    this.name = new.target.name;
    this.status = opts.status;
    this.code = opts.code;
    this.title = opts.title;
    this.detail = opts.detail;
    this.errores = opts.errores;
    this.alternativas = opts.alternativas;
  }

  toProblemJson(instance?: string): ProblemJson {
    return {
      type: `${PROBLEM_BASE_URI}/${this.code}`,
      title: this.title,
      status: this.status,
      detail: this.detail,
      ...(instance !== undefined ? { instance } : {}),
      ...(this.errores !== undefined ? { errores: this.errores } : {}),
      ...(this.alternativas !== undefined
        ? { alternativas: this.alternativas }
        : {}),
    };
  }
}

export class BadRequestError extends AppError {
  constructor(detail = "La petición está mal formada.") {
    super({ status: 400, code: "solicitud-invalida", title: "Solicitud inválida", detail });
  }
}

export class ValidationError extends AppError {
  constructor(errores: ErrorCampo[], detail = "La petición no cumple la validación del contrato.") {
    super({ status: 422, code: "validacion", title: "Error de validación", detail, errores });
  }
}

export class UnauthorizedError extends AppError {
  constructor(detail = "Se requiere una sesión válida.") {
    super({ status: 401, code: "no-autorizado", title: "No autorizado", detail });
  }
}

export class ForbiddenError extends AppError {
  constructor(detail = "La acción no está permitida.") {
    super({ status: 403, code: "prohibido", title: "Prohibido", detail });
  }
}

export class NotFoundError extends AppError {
  constructor(detail = "El recurso no existe.") {
    super({ status: 404, code: "no-encontrado", title: "No encontrado", detail });
  }
}

export class ConflictError extends AppError {
  constructor(detail = "El estado actual impide la operación.", alternativas?: string[]) {
    super({ status: 409, code: "conflicto", title: "Conflicto", detail, alternativas });
  }
}

export class GoneError extends AppError {
  constructor(detail = "El recurso expiró o alcanzó un estado terminal.") {
    super({ status: 410, code: "expirado", title: "Recurso expirado", detail });
  }
}

export class TooManyRequestsError extends AppError {
  constructor(detail = "Demasiadas peticiones; intente más tarde.") {
    super({ status: 429, code: "demasiadas-peticiones", title: "Demasiadas peticiones", detail });
  }
}

/** Mapea el error de validación de Fastify (schema) a 422 problem+json. */
function validationDeFastify(error: FastifyError): ValidationError {
  const errores: ErrorCampo[] = (error.validation ?? []).map((v) => ({
    campo: v.instancePath.replace(/^\//, "") || "body",
    mensaje: v.message ?? "valor inválido",
  }));
  return new ValidationError(errores);
}

export function createErrorHandler(logger: ErrorLogger) {
  return (
    error: FastifyError,
    request: FastifyRequest,
    reply: FastifyReply,
  ): FastifyReply => {
    const instance = request.url;

    if (error instanceof AppError) {
      return reply
        .status(error.status)
        .type("application/problem+json")
        .send(error.toProblemJson(instance));
    }

    if (error.validation) {
      const validationError = validationDeFastify(error);
      return reply
        .status(validationError.status)
        .type("application/problem+json")
        .send(validationError.toProblemJson(instance));
    }

    // Error inesperado: respuesta genérica sin internals, log con request_id.
    logger.error(
      { err: error, request_id: request.id },
      "error no controlado",
    );
    const generico = new AppError({
      status: 500,
      code: "error-interno",
      title: "Error interno",
      detail: "Ocurrió un error inesperado. Intente nuevamente.",
    });
    return reply
      .status(500)
      .type("application/problem+json")
      .send(generico.toProblemJson(instance));
  };
}