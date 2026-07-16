// Local verification config: `vite preview`/`vite dev` with API calls proxied
// to a relay you name via EKHO_RELAY_ORIGIN, so the UI can be driven
// end-to-end from a workstation before deploying ui-dist. Not used by the
// production build (vite.config.js).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = process.env.EKHO_RELAY_ORIGIN || "http://127.0.0.1:4000";
const proxy = { "/v1": { target, changeOrigin: true, secure: true } };

export default defineConfig({
  plugins: [react()],
  root: "frontend",
  base: "/ui/",
  build: { outDir: "../ui-dist", emptyOutDir: true },
  preview: { port: 4517, proxy },
  server: { port: 4517, proxy },
});
