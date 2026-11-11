import { defineConfig } from "vitest/config";

// Only for the `migration-roundtrip` CI job. The ordinary suite
// (vitest.config.ts, tests/**/*.test.ts) never includes these files: each one
// is a single phase that needs EKHO_ROUNDTRIP_* and a database left by the
// phase before it. See tests/roundtrip/migration-025.roundtrip.ts.
export default defineConfig({
  test: {
    include: ["tests/roundtrip/*.roundtrip.ts"],
    testTimeout: 60_000,
    fileParallelism: false
  }
});
