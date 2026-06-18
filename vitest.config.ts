import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Integration tests (live Postgres/Redis) run via the integration config only.
    exclude: ["**/node_modules/**", "**/dist/**", "tests/integration/**"],
    environment: "node",
  },
});
