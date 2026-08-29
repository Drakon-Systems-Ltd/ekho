import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname);
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const readJson = (rel: string) => JSON.parse(read(rel));

function capture(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern);
  expect(match, `${label} should match ${pattern}`).toBeTruthy();
  return match![1].trim().replace(/^["']|["']$/g, "");
}

describe("release version lockstep", () => {
  const expected = readJson("packages/relay/package.json").version as string;

  it("matches every publish, deploy, and user-visible surface", () => {
    const lock = readJson("package-lock.json");
    const workspace: Array<[string, string]> = Object.entries(
      lock.packages as Record<string, { version?: string }>
    )
      .filter(([key, pkg]) => /^packages\/[^/]+$/.test(key) && pkg.version)
      .map(([key, pkg]) => [key, pkg.version!]);

    const surfaces: Array<[string, string]> = [
      ["packages/sdk/package.json", readJson("packages/sdk/package.json").version],
      ["packages/openclaw-plugin/package.json", readJson("packages/openclaw-plugin/package.json").version],
      ["packages/shieldcortex-bridge/package.json", readJson("packages/shieldcortex-bridge/package.json").version],
      ["openclaw.plugin.json", readJson("packages/openclaw-plugin/openclaw.plugin.json").version],
      [
        "relay GET / version",
        capture(
          read("packages/relay/src/server.ts"),
          /app\.get\("\/", async \(\) => \(\{\s*service: "ekho-relay",\s*version: "([^"]+)"/,
          "relay root response"
        )
      ],
      [
        "metrics RELAY_VERSION",
        capture(read("packages/relay/src/metrics.ts"), /^const RELAY_VERSION = "([^"]+)";$/m, "metrics RELAY_VERSION")
      ],
      [
        "A2A RELAY_VERSION",
        capture(read("packages/relay/src/a2a/agent-card.ts"), /^const RELAY_VERSION = "([^"]+)";$/m, "A2A RELAY_VERSION")
      ],
      [
        "Helm Chart.yaml version",
        capture(read("deploy/helm/ekho/Chart.yaml"), /^version:\s*(.+)$/m, "Helm version")
      ],
      [
        "Helm Chart.yaml appVersion",
        capture(read("deploy/helm/ekho/Chart.yaml"), /^appVersion:\s*(.+)$/m, "Helm appVersion")
      ],
      [
        "Helm values image.tag",
        capture(read("deploy/helm/ekho/values.yaml"), /^image:\n(?:[ \t].+\n)*?[ \t]+tag:\s*(.+)$/m, "Helm image.tag")
      ],
      [
        "OpenAPI info.version",
        capture(read("openapi.yaml"), /^info:\n(?:[ \t].+\n)*?[ \t]+version:\s*(.+)$/m, "OpenAPI info.version")
      ],
      [
        "OpenAPI ServiceInfo example",
        capture(
          read("openapi.yaml"),
          /ServiceInfoResponse:[\s\S]*?\n[ \t]+version:\n[ \t]+type: string\n[ \t]+example:\s*(.+)/,
          "OpenAPI example"
        )
      ],
      [
        "README current release",
        capture(read("README.md"), /\*\*Current release:\*\* `v([^`]+)`/, "README current release")
      ],
      [
        "README project status",
        capture(read("README.md"), /## Project Status\n\nEkho `v([^`]+)` is released/, "README project status")
      ],
      ...workspace
    ];

    for (const [label, actual] of surfaces) {
      expect(actual, label).toBe(expected);
    }
  });

  it("does not mark the SDK npm publish step continue-on-error", () => {
    const workflow = read(".github/workflows/release.yml");
    const step = workflow.split(/^\s+- name:\s*/m).find((chunk) =>
      chunk.startsWith("Publish @drakon-systems/ekho-sdk to npm")
    );
    expect(step, "SDK publish step").toBeTruthy();
    const keys = step!
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    expect(keys.some((line) => /^continue-on-error\s*:/.test(line))).toBe(false);
  });
});
