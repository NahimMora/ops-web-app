import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { OPS_LOG_LEVEL: "silent" },
    include: ["tests/**/*.test.ts"],
    coverage: { reporter: ["text", "json-summary"] },
  },
});
