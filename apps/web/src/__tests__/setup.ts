import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest no expone `afterEach` global (globals: false), por lo que el
// auto-cleanup de Testing Library no se activa solo: lo hacemos explícito
// para evitar que el DOM de un test se filtre al siguiente.
afterEach(() => {
  cleanup();
});
