/**
 * @sistema-reservas/contracts — contrato compartido del Sistema de Reservas.
 *
 * - enums.ts: enums compartidos (patrón const types) — espejo de los enums
 *   PostgreSQL y del contrato OpenAPI.
 * - generated/api.ts: tipos generados desde openapi.yaml (openapi-typescript).
 */
export * from "./enums";
export type {
  components,
  paths,
  operations,
  webhooks,
} from "./generated/api";