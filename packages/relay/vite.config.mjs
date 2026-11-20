import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { consoleBuildDefine } from "./vite.build-stamp.mjs";

export default defineConfig({
  plugins: [react()],
  root: "frontend",
  base: "/ui/",
  // #97: console version + commit, see vite.build-stamp.mjs.
  define: consoleBuildDefine(),
  build: {
    outDir: "../ui-dist",
    emptyOutDir: true,
  },
});
