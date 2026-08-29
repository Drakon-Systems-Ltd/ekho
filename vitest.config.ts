import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      {
        test: {
          name: "root",
          include: ["release-version-lockstep.test.ts"]
        }
      }
    ]
  }
});
