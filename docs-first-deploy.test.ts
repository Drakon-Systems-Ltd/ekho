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

// #130 slice A2: environment variables, their defaults, the floor-TTL cap,
// relay-only npm scripts and the Helm readiness step. As above, every value is
// read from the source that defines it.

/** Every Markdown file in the repo, skipping dependencies, build output and the
 *  changelogs (whose history entries record that a script does NOT exist). */
function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", "ui-dist"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, out);
    else if (entry.name.endsWith(".md") && !/CHANGELOG/i.test(entry.name)) out.push(full);
  }
  return out;
}

describe("environment variable and command docs match the source (#130 slice A2)", () => {
  const rootReadme = read("README.md");
  const operations = read("docs/operations.md");
  const helmReadme = read("deploy/helm/ekho/README.md");
  const pluginReadme = read("packages/openclaw-plugin/README.md");
  const hermesReadme = read("packages/hermes-plugin/README.md");
  const configTs = read("packages/relay/src/config.ts");
  const autoreplyPy = read("packages/hermes-plugin/ekho_hermes/autoreply.py");

  /** Default of a numeric relay setting, read from its resolveNumber() call. */
  const relayDefault = (envVar: string): string =>
    capture(configTs, new RegExp(`resolveNumber\\(process\\.env\\.${envVar}, ([0-9_]+)\\)`), `config.ts ${envVar}`).replace(/_/g, "");
  /** The whole `| \`VAR\` | ... |` row of a Markdown table. */
  const tableRow = (doc: string, envVar: string, label: string): string =>
    capture(doc, new RegExp(`^(\\| \`${envVar}\`[^\\n]*)$`, "m"), `${label} row for ${envVar}`);
  /** The default cell of a `| \`VAR\` | \`default\` | ...` row. */
  const tableDefault = (doc: string, envVar: string, label: string): string =>
    capture(doc, new RegExp(`^\\| \`${envVar}\`[^|]*\\| \`([^\`]+)\` \\|`, "m"), `${label} default for ${envVar}`);
  /** match[1] untrimmed, for source blocks where indentation is the structure. */
  const block = (source: string, pattern: RegExp, label: string): string => {
    const match = source.match(pattern);
    expect(match, `${label} should match ${pattern}`).toBeTruthy();
    return match![1];
  };
  /** Emphasis and line wraps normalised so checks read the words, not the Markdown. */
  const plain = (text: string) => text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  /** Hermes turn-timeout default. _turn_timeout_s() in autoreply.py has two
   *  fallback returns: the `except ValueError` branch, which is the path an
   *  unset variable takes (the env read defaults to "" and float("") raises),
   *  and the below-minimum else-branch. Both are read, both must agree, and
   *  the docs state that one value. */
  const hermesTurnTimeout = (): string => {
    const parser = autoreplyPy.match(
      /^def _turn_timeout_s\(\) -> float:\n(?:(?:[ \t].*)?\n)*?[ \t]+try:\n[ \t]+raw = float\(os\.environ\.get\("EKHO_AUTOREPLY_TURN_TIMEOUT_SECONDS", "([^"]*)"\)\)\n[ \t]+except ValueError:\n[ \t]+return ([0-9]+)(?:\.0)?\n[ \t]+return raw if raw >= 60 else ([0-9]+)(?:\.0)?\n/m
    );
    expect(parser, "_turn_timeout_s: try/except ValueError around the env read, then the >= 60 floor").toBeTruthy();
    const [, envDefault, unsetFallback, belowMinimumFallback] = parser!;
    expect(envDefault, 'the env read defaults to "", so an unset variable reaches the except ValueError return').toBe("");
    expect(belowMinimumFallback, "both fallback returns are the one documented default").toBe(unsetFallback);
    return unsetFallback;
  };

  it("root README relay table lists the skew, sweep, rate-limit window and liveness settings with config.ts defaults", () => {
    for (const envVar of [
      "EKHO_TIMESTAMP_SKEW_SECONDS",
      "EKHO_SWEEP_INTERVAL_MS",
      "EKHO_RATE_LIMIT_WINDOW_SECONDS",
      "EKHO_HEARTBEAT_LIVENESS_THRESHOLD"
    ]) {
      expect(tableDefault(rootReadme, envVar, "README"), envVar).toBe(relayDefault(envVar));
    }
  });

  it("EKHO_DEV_INSECURE is described as a development-only switch doing what server.ts does", () => {
    expect(read("packages/relay/src/server.ts")).toContain(
      "assertOperatorSecret(config.operatorSessionSecret, Boolean(process.env.EKHO_DEV_INSECURE))"
    );
    const row = tableRow(rootReadme, "EKHO_DEV_INSECURE", "README");
    expect(row).toMatch(/\| — \|/);
    expect(row).toMatch(/development only/i);
    expect(row).toContain("`EKHO_OPERATOR_SESSION_SECRET`");
    expect(row).toMatch(/any non-empty value/i);
    expect(row).toMatch(/never/i);
  });

  it("EKHO_DB_PATH default is the path config.ts resolves against its own directory", () => {
    const joinArgs = capture(configTs, /process\.env\.EKHO_DB_PATH \?\? path\.join\(__dirname, ([^)]+)\)/, "EKHO_DB_PATH fallback");
    const segments = joinArgs.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    const dbDefault = path.posix.join("packages/relay/src", ...segments);
    expect(dbDefault).toBe("packages/relay/data/ekho.sqlite");
    expect(tableDefault(rootReadme, "EKHO_DB_PATH", "README")).toBe(dbDefault);
    expect(tableDefault(operations, "EKHO_DB_PATH", "operations")).toBe(dbDefault);
    expect(rootReadme).not.toContain("`./data/ekho.sqlite`");
    expect(operations).not.toContain("`./data/ekho.sqlite`");
  });

  it("EKHO_REQUIRE_SIGNED is documented with every mode the SDK accepts and the warn default", () => {
    const verification = read("packages/sdk/src/identity/verification.ts");
    const modes = capture(verification, /^export type RequireSignedMode = (.+);$/m, "RequireSignedMode")
      .split("|")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""));
    expect(modes).toEqual(["off", "warn", "require"]);
    const fallback = capture(verification, /return v === "require" \|\| v === "off" \? v : "([a-z]+)";/, "SDK fallback mode");
    // Every reader goes through the same parser (or its Python twin).
    expect(read("packages/openclaw-plugin/src/connection.ts")).toContain("parseRequireSignedMode(process.env.EKHO_REQUIRE_SIGNED");
    expect(read("packages/mcp-connector/src/config.ts")).toContain('parseRequireSignedMode(str(env, "EKHO_REQUIRE_SIGNED"))');
    expect(
      capture(read("packages/hermes-plugin/ekho_hermes/verification.py"), /return v if v in \("require", "off"\) else "([a-z]+)"/, "Python fallback mode")
    ).toBe(fallback);
    expect(read("packages/hermes-plugin/ekho_hermes/config.py")).toContain('require_signed=parse_require_signed_mode(env.get("EKHO_REQUIRE_SIGNED"))');

    const readmeRow = tableRow(rootReadme, "EKHO_REQUIRE_SIGNED", "README");
    expect(tableDefault(rootReadme, "EKHO_REQUIRE_SIGNED", "README")).toBe(fallback);
    const pluginRow = tableRow(pluginReadme, "EKHO_REQUIRE_SIGNED", "plugin README");
    expect(tableDefault(pluginReadme, "EKHO_REQUIRE_SIGNED", "plugin README")).toBe(fallback);
    const configure = capture(hermesReadme, /^## Configure\n([\s\S]*?)(?=^## )/m, "Hermes Configure section");
    const hermesLine = capture(configure, /^(# EKHO_REQUIRE_SIGNED=[^\n]+)$/m, "Hermes EKHO_REQUIRE_SIGNED line");
    expect(capture(hermesLine, /^# EKHO_REQUIRE_SIGNED=([a-z]+)/, "Hermes example value")).toBe(fallback);
    for (const mode of modes) {
      expect(readmeRow, `README names ${mode}`).toContain(`\`${mode}\``);
      expect(pluginRow, `plugin README names ${mode}`).toContain(`\`${mode}\``);
      expect(hermesLine, `Hermes README names ${mode}`).toMatch(new RegExp(`\\b${mode}\\b`));
    }
  });

  it("EKHO_REQUIRE_SIGNED docs say a failed signature is rejected in every mode, and the Hermes README describes the operator gate", () => {
    const verificationPy = read("packages/hermes-plugin/ekho_hermes/verification.py");
    const verificationTs = read("packages/sdk/src/identity/verification.ts");

    // Operator branch, both implementations: a signed message that has a
    // verification result is judged on that result, before and regardless of
    // the operator-trusted toggle, which is only the fallback below it. The
    // mode is never consulted for an operator message.
    // Bound every gate assertion to the named function's own body: from its
    // `def`/`export function` line to the next top-level line (Python: the
    // first column-0 line that is not the signature's closing paren; TS: the
    // first column-0 closing brace).
    const autowakePy = block(verificationPy, /^(def should_autowake\([\s\S]*?\n)(?=[^\s)])/m, "should_autowake body");
    const autowakeTs = block(verificationTs, /^(export function shouldAutowake\([\s\S]*?\n\}\n)/m, "shouldAutowake body");
    const operatorPy = block(autowakePy, /^    if is_operator:\n((?:        .*\n)+)/m, "should_autowake operator branch");
    expect(operatorPy).toMatch(
      /^        if signed and verification is not None:\n(?:            #.*\n)*            return bool\(verification\.verified\)\n(?:        #.*\n)*        return bool\(operator_trusted\)\n$/
    );
    expect(operatorPy).not.toContain("require_signed");
    const operatorTs = block(autowakeTs, /^  if \(isOperator\) \{\n((?:    .*\n)+?)  \}\n/m, "shouldAutowake operator branch");
    expect(operatorTs).toMatch(/^    if \(signed && verification\) return Boolean\(verification\.verified\);\n    return Boolean\(operatorTrusted\);\n$/);
    expect(operatorTs).not.toContain("requireSigned");

    // Peer branch: the `require` block returns true only for a signed message
    // whose verification result is present and verified (comments aside, its
    // whole body is that one return); after it (so in warn and off) a signed
    // message with a result returns that result, so a failed signature never
    // wakes a turn in any mode. The MCP connector's own gate agrees.
    expect(autowakePy).toMatch(
      /^    if require_signed == "require":\n(?:        #.*\n)*        return bool\(signed and verification is not None and verification\.verified\)\n    if signed and verification is not None:\n        return bool\(verification\.verified\)\n    return True\n$/m
    );
    expect(autowakeTs).toMatch(
      /^  if \(requireSigned === "require"\) \{\n(?:    \/\/.*\n)*    return Boolean\(signed && verification && verification\.verified\);\n  \}\n  if \(signed && verification\) return Boolean\(verification\.verified\);\n  return true;\n\}\n$/m
    );
    expect(read("packages/mcp-connector/src/agent.ts")).toMatch(
      /this\.opts\.requireSigned === "require"\n\s+\? v\.status === "verified" \|\| v\.status === "relay_attested"\n\s+: v\.status !== "failed";/
    );

    const rejected = /signed (?:peer|teammate) message whose signature fails verification is rejected in every mode, `off` included/;
    const readmeRow = tableRow(rootReadme, "EKHO_REQUIRE_SIGNED", "README");
    const pluginRow = tableRow(pluginReadme, "EKHO_REQUIRE_SIGNED", "plugin README");
    const strictness = plain(capture(hermesReadme, /^### Peer message strictness\n([\s\S]*?)(?=^#{2,3} )/m, "Hermes strictness section"));
    for (const [label, text] of [["README", readmeRow], ["plugin README", pluginRow], ["Hermes README", strictness]] as const) {
      expect(text, label).toMatch(rejected);
      expect(text, label).toMatch(/no pinned operator key/);
      expect(text, label).not.toMatch(/unverifiable/);
    }
    expect(pluginRow).toContain("Operator messages are unaffected");
    expect(strictness).toContain("Operator messages are unaffected by `EKHO_REQUIRE_SIGNED`");
    expect(strictness).toMatch(/signed operator message is accepted or rejected on its verification result alone/);
    expect(strictness).toMatch(/operator-trusted toggle decides only an unsigned operator message/);
    expect(strictness).not.toMatch(/follow the console's operator-trusted toggle/);
  });

  it("Hermes Configure block lists the env vars autoreply.py and connection.py read, with their defaults", () => {
    const connectionPy = read("packages/hermes-plugin/ekho_hermes/connection.py");
    const configure = capture(hermesReadme, /^## Configure\n([\s\S]*?)(?=^## )/m, "Hermes Configure section");

    expect(capture(configure, /^# EKHO_AUTOREPLY_TURN_TIMEOUT_SECONDS=([0-9]+)/m, "Hermes turn timeout example")).toBe(hermesTurnTimeout());
    expect(configure).toMatch(/^# EKHO_AUTOREPLY_TURN_TIMEOUT_SECONDS=[0-9]+ +#.*under 60/m);

    expect(autoreplyPy).toMatch(/^EKHO_AUTOREPLY_DISABLE_ENV = "EKHO_AUTOREPLY_DISABLE"$/m);
    expect(connectionPy).toContain('env.get(autoreply.EKHO_AUTOREPLY_DISABLE_ENV) == "1"');
    expect(configure).toMatch(/^# EKHO_AUTOREPLY_DISABLE=1 /m);

    for (const envVar of ["EKHO_REPORT_MODEL", "EKHO_REPORT_PROVIDER"]) {
      expect(connectionPy).toContain(`os.environ.get("${envVar}")`);
      expect(configure, envVar).toMatch(new RegExp(`^# ${envVar}=`, "m"));
    }
  });

  it("Hermes turn-timeout default is the same in both autoreply.py fallback returns, and the docs state it", () => {
    const timeout = hermesTurnTimeout();
    expect(hermesReadme).toContain(`# EKHO_AUTOREPLY_TURN_TIMEOUT_SECONDS=${timeout} `);
    const hermesNote = capture(hermesReadme, /^### Turn timeout and the conversation floor\n([\s\S]*?)(?=^#{2,3} )/m, "Hermes floor note");
    expect(hermesNote).toContain(`(default \`${timeout}\`;`);
    expect(tableDefault(pluginReadme, "EKHO_AUTOREPLY_TURN_TIMEOUT_SECONDS", "plugin README")).toBe(timeout);
  });

  it("turn-timeout docs say the relay caps the floor at EKHO_FLOOR_TTL_MAX_SECONDS and name the value to raise it to", () => {
    const relayMax = Number(relayDefault("EKHO_FLOOR_TTL_MAX_SECONDS"));
    expect(read("packages/relay/src/routes-agent.ts")).toMatch(/Math\.min\([^\n]*config\.floorTtlMaxSeconds\)/);

    const autoreplyTs = read("packages/openclaw-plugin/src/autoreply.ts");
    const timeout = Number(capture(autoreplyTs, /return Number\.isFinite\(raw\) && raw >= 60 \? raw : ([0-9]+);/, "plugin turn timeout default"));
    const grace = Number(capture(autoreplyTs, /^export const FLOOR_TTL_SECONDS = TURN_TIMEOUT_SECONDS \+ ([0-9]+);/m, "plugin floor grace"));
    expect(Number(hermesTurnTimeout())).toBe(timeout);
    expect(Number(capture(autoreplyPy, /^FLOOR_TTL_SECONDS = int\(TURN_TIMEOUT_S\) \+ ([0-9]+)$/m, "Hermes floor grace"))).toBe(grace);
    const needed = timeout + grace;
    expect(needed, "the note only makes sense while the default request exceeds the relay cap").toBeGreaterThan(relayMax);

    const pluginRow = tableRow(pluginReadme, "EKHO_AUTOREPLY_TURN_TIMEOUT_SECONDS", "plugin README");
    expect(tableDefault(pluginReadme, "EKHO_AUTOREPLY_TURN_TIMEOUT_SECONDS", "plugin README")).toBe(String(timeout));
    expect(pluginRow).toContain(`plus ${grace} seconds`);
    expect(pluginRow).toContain("`EKHO_FLOOR_TTL_MAX_SECONDS`");
    expect(pluginRow).toContain(`\`${relayMax}\``);
    expect(pluginRow).toContain(`\`${needed}\``);

    const hermesNote = capture(hermesReadme, /^### Turn timeout and the conversation floor\n([\s\S]*?)(?=^#{2,3} )/m, "Hermes floor note");
    expect(hermesNote).toContain("`EKHO_AUTOREPLY_TURN_TIMEOUT_SECONDS`");
    expect(hermesNote).toContain(`plus ${grace} seconds`);
    expect(hermesNote).toContain("`EKHO_FLOOR_TTL_MAX_SECONDS`");
    expect(hermesNote).toContain(`\`${relayMax}\``);
    expect(hermesNote).toContain(`\`${needed}\``);
  });

  it("docs give the -w @ekho/relay form for npm scripts that exist only in packages/relay, and list the real doctor checks", () => {
    const rootScripts = Object.keys(JSON.parse(read("package.json")).scripts as Record<string, string>);
    const relayPkg = JSON.parse(read("packages/relay/package.json")) as { name: string; scripts: Record<string, string> };
    expect(relayPkg.name).toBe("@ekho/relay");
    const relayOnly = Object.keys(relayPkg.scripts).filter((script) => !rootScripts.includes(script));
    expect(relayOnly).toEqual(expect.arrayContaining(["ui:build", "doctor", "agent:demo"]));

    const setupWizard = read("docs/setup-wizard.md");
    const agentAdapter = read("docs/agent-adapter.md");
    for (const [label, text] of [["docs/setup-wizard.md", setupWizard], ["docs/agent-adapter.md", agentAdapter]] as const) {
      for (const script of relayOnly) {
        expect(text, `${label}: bare npm run ${script}`).not.toMatch(new RegExp(`npm run ${script}(?! -w @ekho/relay)`));
      }
    }
    expect(setupWizard).toContain("npm run ui:build -w @ekho/relay");
    expect(setupWizard).toContain("npm run doctor -w @ekho/relay");
    expect(agentAdapter).toContain("npm run agent:demo -w @ekho/relay");

    const doctorBody = capture(read("packages/relay/src/setup.ts"), /async function runDoctor\(\) \{([\s\S]*?)\n\}/, "runDoctor");
    const checks = [...new Set([...doctorBody.matchAll(/\b(?:pass|warn|fail)\("([^"]+)"/g)].map((m) => m[1]))];
    expect(checks).toEqual(["Node", "Database", "Secret", "Base URL", "Port", "License"]);
    expect(doctorBody).not.toMatch(/fetch\(|https?:/);
    const doctorSection = capture(setupWizard, /^## Doctor Command\n([\s\S]*)$/m, "setup-wizard Doctor section");
    const bullets = doctorSection.split("\n").filter((line) => line.startsWith("- "));
    expect(bullets).toHaveLength(checks.length);
    const keyword: Record<string, RegExp> = {
      Node: /\bNode\b/,
      Database: /database/i,
      Secret: /session secret/i,
      "Base URL": /base URL/i,
      Port: /\bport\b/i,
      License: /licen[sc]e/i
    };
    for (const check of checks) {
      expect(bullets.some((bullet) => keyword[check].test(bullet)), `doctor section lists the ${check} check`).toBe(true);
    }

    // The secret check is inequality with the shipped default and nothing
    // else: config.ts keeps an explicitly empty value (??), doctor passes it,
    // and only the server's isInsecureSecret() refuses it.
    expect(doctorBody).toContain('if (config.operatorSessionSecret !== "change-me") {');
    expect(doctorBody).not.toMatch(/isInsecureSecret|!config\.operatorSessionSecret/);
    expect(configTs).toContain('operatorSessionSecret: process.env.EKHO_OPERATOR_SESSION_SECRET ?? "change-me"');
    expect(configTs).toMatch(/^export function isInsecureSecret\(secret: string\): boolean \{\n  return !secret \|\| secret === "change-me";\n\}/m);
    expect(configTs).toMatch(/if \(isInsecureSecret\(secret\) && !allowInsecure\)/);
    const secretBullet = bullets.find((bullet) => keyword.Secret.test(bullet))!;
    expect(secretBullet).toContain("differs from the shipped `change-me` default");
    expect(secretBullet).toMatch(/does not reject an explicitly empty value/);
    expect(secretBullet).toMatch(/server refuses to start/);
    expect(secretBullet).toContain("`EKHO_DEV_INSECURE`");
    expect(secretBullet).not.toMatch(/something other than the default/);
    expect(doctorSection).not.toMatch(/connectivity/i);
    expect(read("packages/relay/README.md")).not.toMatch(/connectivity/i);
  });

  it("Helm first-operator step waits for the relay pod to be ready before kubectl exec", () => {
    expect(read("deploy/helm/ekho/templates/_helpers.tpl")).toMatch(/^app\.kubernetes\.io\/instance: \{\{ \.Release\.Name \}\}$/m);
    const statefulSet = read("deploy/helm/ekho/templates/statefulset.yaml");
    expect(statefulSet).toContain("readinessProbe:");
    // The label the docs wait on must be on the pod template (what `-l`
    // selects), not only on the StatefulSet's own metadata and selector.
    expect(statefulSet).toMatch(/^  selector:\n    matchLabels:\n      \{\{- include "ekho\.selectorLabels" \. \| nindent 6 \}\}$/m);
    const podLabels = block(statefulSet, /^  template:\n    metadata:\n      labels:\n((?:        .*\n)+)/m, "StatefulSet pod-template labels");
    expect(podLabels).toMatch(/^        \{\{- include "ekho\.selectorLabels" \. \| nindent 8 \}\}$/m);
    const waitCmd = /kubectl (?:-n|--namespace) ekho wait --for=condition=ready pod -l app\.kubernetes\.io\/instance=ekho --timeout=\d+s/;
    const execCmd = "exec -it ekho-0 -- tsx packages/relay/src/setup.ts";
    for (const [label, text] of [["Helm README", helmReadme], ["operations", operations]] as const) {
      const wait = text.search(waitCmd);
      expect(wait, `${label} waits for readiness`).toBeGreaterThan(-1);
      expect(text.indexOf(execCmd), `${label} waits before exec`).toBeGreaterThan(wait);
    }
    // The Helm README's port-forward runs in the foreground.
    expect(helmReadme).toMatch(/second terminal/);
  });

  it("no doc names a create-operator.ts script", () => {
    const files = markdownFiles(root);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      expect(fs.readFileSync(file, "utf8"), path.relative(root, file)).not.toContain("create-operator");
    }
  });
});
