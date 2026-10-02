import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "apps/api/vitest.config.ts",
  "apps/web/vitest.config.ts",
  "packages/contracts/vitest.config.ts",
]);