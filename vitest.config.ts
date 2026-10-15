import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // O "server-only" lança fora do runtime do React Server; nos testes é um módulo vazio.
      "server-only": path.resolve(__dirname, "tests/server-only-vazio.ts"),
    },
  },
});
