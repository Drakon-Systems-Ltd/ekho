import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "frontend",
  base: "/ui/",
  build: {
    outDir: "../ui-dist",
    emptyOutDir: true,
  },
});
