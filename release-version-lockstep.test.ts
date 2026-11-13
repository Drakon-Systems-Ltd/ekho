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
        "README release version",
        capture(read("README.md"), /\*\*Release version:\*\* `v([^`]+)`/, "README release version")
      ],
      [
        "README project status",
        capture(read("README.md"), /## Project Status\n\nEkho `v([^`]+)` is the release version\./, "README project status")
      ],
      ...workspace
    ];

    for (const [label, actual] of surfaces) {
      expect(actual, label).toBe(expected);
    }
  });

  it("keeps final release copy generic and publication-neutral", () => {
    const changelog = read("CHANGELOG.md").split(/^## \[/m)[2];
    expect(changelog, "current version changelog section").toBeTruthy();
    expect(changelog).toMatch(new RegExp(`^${expected.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}\\n`));
    expect(changelog).toMatch(
      /\] - \d{4}-\d{2}-\d{2}\n\nRelay, SDK and OpenClaw plugin update: delivery timing fields \(#163\), cold inbox attachment recovery \(#175\), and security fixes\./
    );
    expect(changelog).toMatch(/### Security\n- \*\*Security fixes\.\*\*/);
    expect(changelog).not.toMatch(/canonical operator DMs|A2A send persistence|room and broadcast sends/i);

    // #175 shipped relay, published SDK and published OpenClaw plugin changes:
    // no copy may claim the release needs no adapter, SDK or plugin changes.
    expect(changelog).toContain("published Node SDK (`@drakon-systems/ekho-sdk`)");
    expect(changelog).toContain("published OpenClaw plugin (`@drakon-systems/ekho-openclaw-plugin`)");
    expect(changelog).toContain("`GET /v1/delivered-messages/{id}`");
    expect(changelog).toContain("`GET /v1/delivered-messages/{id}/attachments/{attachmentId}`");
    expect(changelog).toContain("Neither read consumes or changes inbox or delivery state");
    expect(changelog).toContain("`Cache-Control: private, no-store`");
    expect(changelog).toContain("`getDeliveredMessage(id)` and `downloadDeliveredAttachment(messageId, attachmentId)`");
    expect(changelog).toContain('`recovery: "delivered-message"`');
    expect(changelog).toContain("Recovered messages carry no local signature verdict");
    expect(changelog).not.toMatch(/no (?:adapter|SDK|plugin) changes/i);

    // Rollback copy is bound to the tested v0.7.8 path, never a blanket promise.
    expect(changelog).toContain("Running the previous `v0.7.8` relay build on the migrated database was tested");
    expect(changelog).toContain(
      "it does not guarantee a full rollback, does not reverse the migration, and does not cover older relay builds"
    );
    expect(changelog).not.toMatch(/Rolling back to the previous relay build on the migrated database is safe/i);

    const readme = read("README.md");
    expect(readme).toContain(`**Release version:** \`v${expected}\``);
    expect(readme).toContain(`## Project Status\n\nEkho \`v${expected}\` is the release version.`);
    expect(readme).not.toMatch(/current release candidate|not yet published|is a candidate|is released/i);
    expect(readme.split("## How it works")[0]).toMatch(/security fixes\./);
    expect(readme).toContain(
      `**Release version:** \`v${expected}\` adds relay delivery timing fields (#163), cold inbox attachment recovery (#175), and security fixes.`
    );
    expect(readme).toContain("changes the relay, the published Node SDK and the published OpenClaw plugin");
    expect(readme).not.toMatch(/no (?:adapter|SDK|plugin) changes/i);
    expect(readme.split("## How it works")[0]).not.toMatch(/canonical operator DM|A2A sends now|Room and broadcast sends/i);
  });

  it("does not mark the npm publish step continue-on-error", () => {
    // Since 0.4.9 one step publishes both packages and skips a version that is
    // already on the registry. Skipping a verifiably published version is the
    // only tolerated non-publish; a failed publish must still fail the release.
    const workflow = read(".github/workflows/release.yml");
    const step = workflow.split(/^\s+- name:\s*/m).find((chunk) =>
      chunk.startsWith("Publish to npm")
    );
    expect(step, "npm publish step").toBeTruthy();
    expect(step).toContain("@drakon-systems/ekho-sdk");
    expect(step).toContain("@drakon-systems/ekho-openclaw-plugin");
    const keys = step!
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    expect(keys.some((line) => /^continue-on-error\s*:/.test(line))).toBe(false);
  });
});
