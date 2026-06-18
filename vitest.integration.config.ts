import { defineConfig } from "vitest/config";

// Integration tests exercise the REAL adapters against live services
// (Postgres via DATABASE_URL, Redis via REDIS_URL). Each test skips itself when
// its service env is absent, so this config is always safe to run.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
  },
});
