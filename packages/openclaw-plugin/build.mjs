import { build } from "esbuild";
import { rmSync } from "node:fs";

// Start from a clean dist so stale per-module output from earlier builds can't
// linger alongside the bundle.
rmSync("dist", { recursive: true, force: true });

// Bundle the plugin into a single self-contained ESM file so it can be dropped
// onto any host without a follow-up `npm install`. Runtime deps (typebox, the
// Ekho SDK) are inlined; `openclaw` stays external — the host gateway provides
// it at load time (it's an optional peer dependency).
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["openclaw", "openclaw/*"],
  banner: {
    js: "// @drakon-systems/ekho-openclaw-plugin — bundled. Edit src/, run `npm run build`."
  }
});
