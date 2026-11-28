import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `openclaw` is an optional peer supplied by the host gateway, so it is not
      // installed here. Alias the one module src/ imports at runtime to a stub
      // that mirrors the host's definePluginEntry / buildJsonPluginConfigSchema,
      // so the plugin's tool wiring (#17: ekho_send's factory/toolContext) is
      // testable without a live gateway. Nothing else in the package imports
      // openclaw at runtime (state-dir.ts loads state-paths with a guarded
      // require and falls back).
      "openclaw/plugin-sdk/plugin-entry": fileURLToPath(
        new URL("./tests/stubs/openclaw-plugin-entry.ts", import.meta.url)
      )
    }
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000
  }
});
