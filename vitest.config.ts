import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Hooks spawn real node processes and the agent test sleeps ~30ms per
    // tool call; give everything comfortable headroom on CI/Windows.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
