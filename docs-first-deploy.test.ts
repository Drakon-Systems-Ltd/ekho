import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// #130 slice A1: the first-deployment docs must say what the source does.
// Every expectation below is read from the file that defines the behaviour
// (setup script path, image tag, A2A protocol version and method names,
// Hermes auto-reply default and registered tools), so the docs are pinned to
// the code rather than to a number someone typed once.

const root = path.resolve(__dirname);
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

function capture(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern);
  expect(match, `${label} should match ${pattern}`).toBeTruthy();
  return match![1].trim().replace(/^["']|["']$/g, "");
}

const COUNT_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six"];

describe("first-deployment docs match the source (#130)", () => {
  const rootReadme = read("README.md");
  const operations = read("docs/operations.md");
  const helmReadme = read("deploy/helm/ekho/README.md");

  it("Docker and Helm quickstarts create the first operator with the relay setup script", () => {
    // The image starts only the server; setup.ts is what creates the fleet and operator.
    const dockerfile = read("Dockerfile");
    const serverPath = capture(dockerfile, /^CMD \["tsx", "([^"]+)"\]$/m, "Dockerfile CMD");
    expect(serverPath).toBe("packages/relay/src/server.ts");
    const setupPath = serverPath.replace(/server\.ts$/, "setup.ts");
    expect(fs.existsSync(path.join(root, setupPath)), setupPath).toBe(true);
    expect(read(setupPath)).toContain("db.createBootstrap(");

    const service = capture(read("docker-compose.yml"), /^services:\n {2}([a-z][a-z0-9_-]*):/m, "compose service name");
    const composeCommand = `docker compose exec ${service} tsx ${setupPath}`;
    expect(rootReadme).toContain(composeCommand);
    expect(operations).toContain(composeCommand);

    const notes = read("deploy/helm/ekho/templates/NOTES.txt");
    expect(notes).toContain(`tsx ${setupPath}`);
    expect(helmReadme).toContain(`exec -it ekho-0 -- tsx ${setupPath}`);
    expect(operations).toContain(`exec -it ekho-0 -- tsx ${setupPath}`);

    // The script the Helm README used to name does not exist.
    expect(fs.existsSync(path.join(root, "packages/relay/src/scripts/create-operator.ts"))).toBe(false);
    expect(helmReadme).not.toContain("create-operator");
  });

  it("Helm README and operations guide do not pin a stale image tag", () => {
    const appVersion = capture(read("deploy/helm/ekho/Chart.yaml"), /^appVersion:\s*(.+)$/m, "Chart appVersion");
    const valuesTag = capture(
      read("deploy/helm/ekho/values.yaml"),
      /^image:\n(?:[ \t].+\n)*?[ \t]+tag:\s*(.+)$/m,
      "values.yaml image.tag"
    );
    expect(valuesTag).toBe(appVersion);

    expect(helmReadme).not.toContain("0.3.2");
    expect(operations).not.toContain("0.3.2");

    // Examples use a placeholder; the defaults table names the real default.
    expect(helmReadme).toContain('tag: "<version>"');
    expect(helmReadme).toContain("--set image.tag=<version>");
    expect(operations).toContain("`:<version>`");
    const defaultRow = capture(helmReadme, /^\| `image\.tag` \| `([^`]+)`/m, "Helm README image.tag default row");
    expect(defaultRow).toBe(appVersion);

    // The release workflow publishes the image under the bare semver (the
    // leading "v" of the git tag is stripped), so the docs must not add one.
    const release = read(".github/workflows/release.yml");
    expect(release).toContain('version="${GITHUB_REF#refs/tags/v}"');
    expect(release).toMatch(/type=semver,pattern=\{\{version\}\}/);
    expect(helmReadme).not.toMatch(/image\.tag=v/);
    expect(operations).not.toMatch(/`:v</);
  });

  it("A2A claims match PROTOCOL_VERSION and the JSON-RPC methods the relay handles", () => {
    const protocolVersion = capture(
      read("packages/relay/src/a2a/agent-card.ts"),
      /^const PROTOCOL_VERSION = "([^"]+)";$/m,
      "A2A PROTOCOL_VERSION"
    );
    const majorMinor = protocolVersion.split(".").slice(0, 2).join(".");
    const routes = read("packages/relay/src/a2a/routes.ts");
    const methods = [...routes.matchAll(/^\s+case "([a-z]+\/[A-Za-z]+)": \{$/gm)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThanOrEqual(6);

    const a2aDocs = read("docs/a2a.md");
    const relayReadme = read("packages/relay/README.md");
    const claimFiles: Array<[string, string]> = [
      ["README.md", rootReadme],
      ["docs/a2a.md", a2aDocs],
      ["packages/relay/README.md", relayReadme],
      ["docs/images/ekho-architecture.svg", read("docs/images/ekho-architecture.svg")],
      ["docs/images/ekho-console.svg", read("docs/images/ekho-console.svg")]
    ];
    for (const [label, text] of claimFiles) {
      expect(text, label).not.toMatch(/A2A[ -]v1\.0/i);
      expect(text, label).toContain(`A2A ${majorMinor}`);
    }
    expect(rootReadme).toContain(`img.shields.io/badge/A2A-${majorMinor}-`);
    expect(capture(a2aDocs, /^\*\*Protocol version:\*\* `([^`]+)`$/m, "docs/a2a.md protocol version")).toBe(protocolVersion);
    expect(rootReadme).toContain(`\`${protocolVersion}\``);
    expect(a2aDocs).toContain(`\`${protocolVersion}\``);
    for (const method of methods) {
      expect(rootReadme, `README names ${method}`).toContain(`\`${method}\``);
      expect(a2aDocs, `docs/a2a.md names ${method}`).toContain(`\`${method}\``);
    }
  });

  it("Hermes manifest and README state the real peer auto-reply default and every registered tool", () => {
    const configPy = read("packages/hermes-plugin/ekho_hermes/config.py");
    const manifest = read("packages/hermes-plugin/ekho_hermes/plugin.yaml");
    const hermesReadme = read("packages/hermes-plugin/README.md");

    const parser = capture(configPy, /^\s+peer_autoreply=(\w+)\(env\.get\("EKHO_PEER_AUTOREPLY"\)\),$/m, "peer_autoreply parser");
    const autoreplyDescription = capture(
      manifest,
      /- name: EKHO_PEER_AUTOREPLY\n\s+description: "([^"]+)"/,
      "EKHO_PEER_AUTOREPLY description"
    );
    // The README states the default in two places: the Configure env example
    // and the "Agent-to-agent delegation" section. Emphasis and line wraps are
    // normalised so the checks read the words, not the Markdown.
    const plain = (text: string) => text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    const envLine = plain(
      capture(hermesReadme, /^(?:#\s*)?(EKHO_PEER_AUTOREPLY=[^\n]+)$/m, "README EKHO_PEER_AUTOREPLY env example")
    );
    const delegationSection = plain(
      capture(hermesReadme, /^### Agent-to-agent delegation\n([\s\S]*?)(?=^#{2,3} )/m, "README delegation section")
    );
    if (parser === "_truthy_default_true") {
      const falsey = capture(configPy, /^_FALSEY = \{([^}]+)\}$/m, "_FALSEY")
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""));
      expect(falsey.length).toBeGreaterThan(0);
      expect(autoreplyDescription).toContain("default on");
      expect(autoreplyDescription).not.toContain("default off");
      expect(autoreplyDescription).toContain(`${falsey.join("/")} to disable`);

      expect(envLine).toContain("(default on)");
      expect(envLine).not.toContain("default off");
      expect(falsey).toContain(capture(envLine, /^EKHO_PEER_AUTOREPLY=(\S+)/, "README env example value"));

      expect(delegationSection).toMatch(/^By default the agent auto-replies/);
      expect(delegationSection).toMatch(/agent-to-agent delegation is on\b/);
      const optOut = capture(delegationSection, /Set `EKHO_PEER_AUTOREPLY=([^`]+)` to opt out/, "README delegation opt-out");
      expect(optOut).toBe("0");
      expect(falsey).toContain(optOut);
      expect(delegationSection).not.toMatch(/off by default|default off|delegation is off/);
    } else {
      expect(parser).toBe("_truthy");
      expect(autoreplyDescription).toContain("default off");
      expect(envLine).toContain("(default off)");
      expect(envLine).not.toContain("default on");
      expect(delegationSection).toMatch(/delegation is off\b|off by default/);
      expect(delegationSection).not.toMatch(/delegation is on\b|on by default|default on/);
    }

    const pluginPy = read("packages/hermes-plugin/ekho_hermes/plugin.py");
    const tools = [...pluginPy.matchAll(/ctx\.register_tool\(\n\s+name="([a-z_]+)",/g)].map((m) => m[1]);
    expect(tools).toEqual(["ekho_send", "ekho_open_room", "ekho_inbox"]);
    const healthcheck = read("packages/hermes-plugin/ekho_hermes/healthcheck.py");
    for (const tool of tools) expect(healthcheck).toContain(`"${tool}"`);

    const description = capture(manifest, /^description: "([^"]+)"$/m, "manifest description");
    expect(description).toContain(`${COUNT_WORDS[tools.length]} tools:`);
    const intro = hermesReadme.split(/^## /m)[0];
    expect(intro).toContain(`adds ${COUNT_WORDS[tools.length].toLowerCase()} agent tools`);
    for (const tool of tools) {
      expect(description, `manifest names ${tool}`).toContain(`${tool} (`);
      expect(intro, `README intro names ${tool}`).toContain(`**\`${tool}\`**`);
    }
  });
});
