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
      /\] - \d{4}-\d{2}-\d{2}\n\nRelay and Hermes plugin update: security fixes and relay delivery phase reporting \(#155 slice, PR #176\)\./
    );

    // Security copy is one generic bullet: the heading, the bullet, then the
    // next heading. No further description belongs in release notes.
    const security = changelog.split(/^### /m).find((chunk) => chunk.startsWith("Security\n"));
    expect(security, "Security section").toBeTruthy();
    const securityLines = security!.split("\n").filter((line) => line.trim());
    expect(securityLines).toHaveLength(2);
    expect(securityLines[1]).toMatch(/^- \*\*Security fixes\.\*\* /);

    // The delivery phase slice (#176) is relay-side storage and read-back only:
    // the copy must name the route and migration, say adapters do not report
    // yet, and must not present #155 as finished or an ack as an answer.
    expect(changelog).toContain("`POST /v1/delivery-phases`");
    expect(changelog).toContain("`026_delivery_phase_reports.sql`");
    expect(changelog).toContain("`GET /v1/messages/{id}/status`");
    expect(changelog).toContain("do not send phase reports in this release");
    expect(changelog).toContain("The reply-latency issue (#155) remains open.");
    expect(changelog).toContain("it does not establish that the output answered the delivery");
    expect(changelog).toContain("still means received, not answered");
    expect(changelog).not.toMatch(/(?:closes|fixes|resolves|completes) #155/i);

    // No rollback promise for migration 026.
    expect(changelog).toContain("does not reverse the migration and makes no rollback claim");
    expect(changelog).not.toMatch(/roll(?:ing)? ?back[^.]*\bis safe\b/i);

    // This release changes no published npm package code.
    expect(changelog).toContain("The Node SDK, OpenClaw plugin and MCP connector have no code changes in this release");

    const readme = read("README.md");
    expect(readme).toContain(`**Release version:** \`v${expected}\``);
    expect(readme).toContain(`## Project Status\n\nEkho \`v${expected}\` is the release version.`);
    expect(readme).not.toMatch(/current release candidate|not yet published|is a candidate|is released/i);
    expect(readme).toContain(
      `**Release version:** \`v${expected}\` adds relay delivery phase reporting (#155 slice, PR #176) and security fixes.`
    );
    const intro = readme.split("## How it works")[0];
    expect(intro).toContain("Upgrade the relay to apply migration 026.");
    expect(intro).toContain("Adapters do not send these reports in this release");
    expect(intro).toContain("they do not establish that a delivery was answered");
    expect(intro).not.toMatch(/(?:closes|fixes|resolves|completes) #155/i);
  });

  it("keeps each package's current changelog section truthful about this release", () => {
    // Parse the current version's section of EACH package changelog on its own,
    // so a claim in an older section cannot satisfy or fail these checks.
    const section = (rel: string): string => {
      const found = read(rel)
        .split(/^## \[/m)
        .find((chunk) => chunk.startsWith(`${expected}] - `));
      expect(found, `${rel} [${expected}] section`).toBeTruthy();
      return found!;
    };
    const unpublishedLanguage = /not yet published|release candidate|is a candidate|is released|now (?:live|available) on npm/i;

    // No SDK, OpenClaw plugin or MCP connector source changed in this release;
    // each section says so, names what the release does carry, and stays
    // generic about the security fixes.
    for (const rel of ["packages/sdk/CHANGELOG.md", "packages/openclaw-plugin/CHANGELOG.md", "packages/mcp-connector/CHANGELOG.md"]) {
      const text = section(rel);
      expect(text, rel).toMatch(/^[^\n]*\n\nNo (?:SDK|OpenClaw plugin|MCP connector) changes\. Version kept in step with the relay: /);
      expect(text, rel).toContain("security fixes in the relay and the Hermes plugin");
      expect(text, rel).toContain("#155 slice, PR #176");
      expect(text, rel).toContain("migration 026");
      expect(text, rel).not.toMatch(/(?:closes|fixes|resolves|completes) #155/i);
      expect(text, rel).not.toMatch(unpublishedLanguage);
    }
    expect(section("packages/sdk/CHANGELOG.md")).toContain("The SDK has no method for `POST /v1/delivery-phases` in this release.");
    expect(section("packages/openclaw-plugin/CHANGELOG.md")).toContain(
      "The plugin does not send delivery phase reports in this release."
    );
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
