import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", p), "utf-8"));

// The plugin declares its version twice: package.json (what npm publishes) and
// openclaw.plugin.json (what the agent host reports). They drifted apart and
// stayed apart — every box in the fleet reported 0.2.1 while running 0.3.0 code,
// so the version number was actively misleading rather than merely absent.
// A number that lies is worse than no number, so this fails the build instead.
describe("plugin version declarations stay in lockstep", () => {
  it("package.json and openclaw.plugin.json declare the same version", () => {
    expect(read("openclaw.plugin.json").version).toBe(read("package.json").version);
  });

  it("is publishable under a real, public npm name", () => {
    const pkg = read("package.json");
    // Unscoped-to-npm names can't be published; the old @ekho/* scope never was,
    // which is why the plugin was hand-copied onto machines in the first place.
    expect(pkg.name).toBe("@drakon-systems/ekho-openclaw-plugin");
    expect(pkg.private).toBeUndefined();
    // npm defaults scoped packages to restricted — without this, publish 401s.
    expect(pkg.publishConfig?.access).toBe("public");
  });

  it("ships the files an installing agent actually needs", () => {
    const files = read("package.json").files ?? [];
    for (const required of ["dist", "openclaw.plugin.json", "README.md", "CHANGELOG.md"]) {
      expect(files).toContain(required);
    }
  });
});
