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

// #130 slice A3: the ShieldCortex bridge path, the MCP connector README, the
// security policy, the API spec's scope and the changelogs shipped inside the
// npm packages. As above, every value is read from the source that defines it;
// versions come from package.json, never from a literal in this file.

describe("bridge, connector, security policy, API spec scope and package changelogs match the source (#130 slice A3)", () => {
  const rootReadme = read("README.md");
  const readJson = (rel: string) => JSON.parse(read(rel)) as { version: string };
  const relayVersion = readJson("packages/relay/package.json").version;
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** One Markdown line (a table row, a bullet, a sentence) matched by `pattern`. */
  const line = (doc: string, pattern: RegExp, label: string): string => {
    const match = doc.match(pattern);
    expect(match, `${label} should match ${pattern}`).toBeTruthy();
    return match![0];
  };
  /** match[1] untrimmed, for source blocks where indentation is the structure. */
  const block = (source: string, pattern: RegExp, label: string): string => {
    const match = source.match(pattern);
    expect(match, `${label} should match ${pattern}`).toBeTruthy();
    return match![1];
  };

  it("EKHO_SHIELDCORTEX_PATH is a Node entry script the bridge spawns with node, and the bridge README says so", () => {
    const client = read("packages/shieldcortex-bridge/src/mcp-client.ts");
    expect(client).toContain('spawn("node", [this.binaryPath]');
    expect(read("packages/relay/src/config.ts")).toContain("shieldcortexPath: process.env.EKHO_SHIELDCORTEX_PATH");
    expect(read("packages/relay/src/server.ts")).toContain('await import("@ekho/shieldcortex-bridge")');

    const row = line(rootReadme, /^\| `EKHO_SHIELDCORTEX_PATH` \|.*$/m, "README EKHO_SHIELDCORTEX_PATH row");
    expect(row).not.toMatch(/binary/i);
    expect(row).toContain("Node entry script");
    expect(row).toContain("`node <path>`");
    expect(row).toContain("](packages/shieldcortex-bridge/)");

    const bridgeReadme = read("packages/shieldcortex-bridge/README.md");
    expect(bridgeReadme).toMatch(/^# @ekho\/shieldcortex-bridge$/m);
    expect(bridgeReadme).toContain("`EKHO_SHIELDCORTEX_PATH`");
    expect(bridgeReadme).toContain("`EKHO_SHIELDCORTEX_PROFILE`");
    expect(bridgeReadme).toContain("`node <path>`");
    expect(bridgeReadme).not.toMatch(/binary/i);
    // The tool names, the timeout and the denial text it quotes are the code's.
    const index = read("packages/shieldcortex-bridge/src/index.ts");
    for (const tool of ["iron_dome_scan", "iron_dome_check", "remember"]) {
      expect(index, tool).toContain(`callTool("${tool}"`);
      expect(bridgeReadme, tool).toContain(`\`${tool}\``);
    }
    expect(client).toContain("}, 10_000);");
    expect(bridgeReadme).toMatch(/10 seconds/);
    expect(read("packages/relay/src/message-gate.ts")).toContain("`blocked by extension ${denial.extension}: ${denial.reason}`");
    expect(index).toContain('name: "shieldcortex-bridge"');
    expect(bridgeReadme).toContain("`blocked by extension shieldcortex-bridge: <reason>`");
    // The bridge's own denial string only applies to messages the bridge itself
    // rejects: the gate names whichever extension threw, and earlier sender checks
    // answer with their own status and text.
    const gate = read("packages/relay/src/message-gate.ts");
    expect(gate).toContain("extension: ext.name,");
    expect(gate).toContain('reply.code(429).send({ error: "rate limit exceeded"');
    expect(read("packages/relay/src/a2a/methods.ts")).toContain("{ extension: denial.extension }");
    const denialSentence = line(bridgeReadme, /^.*`blocked by extension shieldcortex-bridge: <reason>`.*$/m, "bridge README denial sentence");
    expect(denialSentence).toMatch(/^A message rejected by the bridge itself \(its scan or action check\)/);
    expect(denialSentence).not.toMatch(/^A rejected message is refused/);
    expect(denialSentence).toContain("a bridge-rejected message gets a JSON-RPC error");
    expect(denialSentence).toContain("`blocked by extension <name>: <reason>`");
    expect(denialSentence).toContain("HTTP 429 `rate limit exceeded`");
  });

  it("bridge README states the failure handling, short-circuit order and reconnect that index.ts and mcp-client.ts implement", () => {
    const index = read("packages/shieldcortex-bridge/src/index.ts");
    const client = read("packages/shieldcortex-bridge/src/mcp-client.ts");
    const bridgeReadme = read("packages/shieldcortex-bridge/README.md");
    const hook = block(index, /async onBeforeMessage\(ctx: BeforeMessageContext\): Promise<void> \{\n([\s\S]*?)\n    \}\n  \};/, "onBeforeMessage body");
    const at = (needle: string): number => {
      const i = hook.indexOf(needle);
      expect(i, `onBeforeMessage contains ${needle}`).toBeGreaterThanOrEqual(0);
      return i;
    };

    // A tool result that is not JSON is swallowed by an empty inner catch, so it
    // never reaches the outer catch that logs the warning; only a failed request does.
    expect(hook).toContain("try { parsed = JSON.parse(scanText); } catch {}");
    expect(hook).toContain("try { gateParsed = JSON.parse(gateText); } catch {}");
    expect(hook).toContain("console.warn(`[shieldcortex-bridge] scan failed: ${err instanceof Error ? err.message : err}`);");
    expect(hook).toContain("console.warn(`[shieldcortex-bridge] action gate failed: ${err instanceof Error ? err.message : err}`);");
    expect(bridgeReadme).toContain("`[shieldcortex-bridge] scan failed:`");
    expect(bridgeReadme).toContain("`[shieldcortex-bridge] action gate failed:`");
    expect(bridgeReadme).toMatch(/not valid JSON is silently ignored/);
    expect(bridgeReadme).not.toMatch(/cannot be parsed, the scan and the action check log a warning/);

    // A `node` that cannot be spawned fails open too (#135, PR #136): the child's
    // `error` listener releases it like an exit, rejecting the pending requests
    // with the spawn error and resetting the client, so the hook's catch blocks
    // log and continue. The README and the root changelog must say so and must no
    // longer say the relay exits or stops.
    const changelog = line(read("CHANGELOG.md"), /^- \*\*ShieldCortex bridge, MCP connector README.*$/m, "root CHANGELOG slice A3 bullet");
    expect(client).toMatch(/child\.on\("error", \(error\) => \{\n\s+this\.releaseChild\(child, error\);/);
    expect(client).toMatch(/child\.on\("exit", \(\) => \{\n\s+this\.releaseChild\(child, new Error\("MCP process exited"\)\);/);
    expect(bridgeReadme).toContain("A failure to launch `node` itself also fails open.");
    expect(bridgeReadme).toContain("The client listens for the child process's `error` event (`src/mcp-client.ts`)");
    expect(bridgeReadme).toMatch(/every pending request is rejected with that error \(for example one with code `ENOENT`\), and the client resets, so the next tool call tries to start a new process/);
    expect(bridgeReadme).toMatch(/a failed `remember` call is silently ignored/);
    expect(bridgeReadme).toContain("The relay no longer exits in this case");
    expect(bridgeReadme).not.toMatch(/registers no `error` listener/);
    expect(bridgeReadme).not.toMatch(/not handled and does not fail open/);
    expect(bridgeReadme).not.toMatch(/the relay process exits instead of logging a warning/);
    expect(changelog).toContain("a failure to launch `node` itself fails open the same way since #135 (PR #136)");
    expect(changelog).toContain("the relay no longer exits");
    expect(changelog).not.toMatch(/a failure to launch `node` itself is not handled and stops the relay/);
    expect(changelog).not.toMatch(/the missing `error` listener on the spawned process/);

    // Rejection is by error-message prefix. The prefixes are read from the two
    // rethrow lines; the bridge builds errors with them, and mcp-client.ts turns a
    // JSON-RPC error into an Error carrying the server's message, so the README
    // must name every prefix and may not say only a parsed decision rejects.
    const scanPrefix = capture(hook, /if \(err instanceof Error && err\.message\.startsWith\(("[^"]+")\)\) throw err;/, "scan rethrow");
    const gateRethrow = line(hook, /^\s*if \(err instanceof Error && \(err\.message\.startsWith\("[^"]+"\) \|\| err\.message\.startsWith\("[^"]+"\)\)\) throw err;$/m, "gate rethrow");
    const gatePrefixes = [...gateRethrow.matchAll(/startsWith\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(gatePrefixes).toHaveLength(2);
    expect(hook).toContain(`throw new Error(\`${scanPrefix} `);
    for (const prefix of gatePrefixes) expect(hook, prefix).toMatch(new RegExp(`throw new Error\\(\`${escapeRe(prefix)}`));
    for (const prefix of [scanPrefix, ...gatePrefixes]) expect(bridgeReadme, prefix).toContain(`\`${prefix}\``);
    expect(client).toContain("req.reject(new Error(msg.error.message));");
    expect(bridgeReadme).toMatch(/JSON-RPC error returned by the server/);
    expect(bridgeReadme).not.toContain("Only an explicit high-risk scan result");

    // Each rethrow sits before the next tool call and nothing wraps the hook, so a
    // strict scan denial never reaches iron_dome_check and a denial of either kind
    // never reaches remember. Five try blocks: scan, its parse, gate, its parse, remember.
    const scanCall = at('callTool("iron_dome_scan"');
    const strictThrow = at(`if (config.defenceProfile === "strict") {\n            throw new Error(\`${scanPrefix} `);
    const scanRethrow = at(`startsWith("${scanPrefix}")) throw err;`);
    const gateCall = at('callTool("iron_dome_check"');
    const gateRethrowAt = hook.indexOf(gateRethrow);
    const rememberCall = at('callTool("remember"');
    expect([scanCall, strictThrow, scanRethrow, gateCall, gateRethrowAt, rememberCall]).toEqual(
      [scanCall, strictThrow, scanRethrow, gateCall, gateRethrowAt, rememberCall].slice().sort((a, b) => a - b)
    );
    expect(hook.match(/\btry \{/g)).toHaveLength(5);
    expect(hook).toMatch(/if \(config\.enableMemoryExtraction\) \{\n\s+void \(async \(\) => \{\n\s+try \{\n\s+await mcp\.callTool\("remember"/);
    // The relay enables both optional steps, so the README describes them unconditionally.
    const server = read("packages/relay/src/server.ts");
    expect(server).toContain("enableMemoryExtraction: true");
    expect(server).toContain("enableIronDome: true");
    // The relay gate refuses by status, rate limit and policy before any extension runs.
    const gateFn = block(read("packages/relay/src/message-gate.ts"), /export async function evaluateMessageGate\([^)]*\): Promise<MessageGateVerdict> \{\n([\s\S]*?)\n\}\n/, "evaluateMessageGate body");
    const gateOrder = ['agent.status === "quarantined"', "db.checkAndIncrementRateLimit(", "db.evaluateMessagePolicies(", "for (const ext of getExtensions())"].map((needle) => {
      const i = gateFn.indexOf(needle);
      expect(i, `evaluateMessageGate contains ${needle}`).toBeGreaterThanOrEqual(0);
      return i;
    });
    expect(gateOrder).toEqual(gateOrder.slice().sort((a, b) => a - b));
    expect(bridgeReadme).toMatch(/never reaches the bridge/);
    expect(bridgeReadme).toMatch(/stops at the first step that rejects it/);
    expect(bridgeReadme).toMatch(/only if neither of the bridge's own steps above rejected it/);
    expect(bridgeReadme).toMatch(/A message rejected by the bridge's scan or action check leaves no memory record/);
    expect(bridgeReadme).not.toMatch(/A rejected message leaves no memory record/);
    // The no-record claim is bridge-local: the gate runs every extension in
    // registration order and remember is fire-and-forget, so a later extension's
    // rejection can follow an already-started memory record.
    expect(read("packages/relay/src/license.ts")).toMatch(/export function registerExtension\(ext: EkhoExtension\) \{\n\s+extensions\.push\(ext\);/);
    expect(gateFn).toMatch(/for \(const ext of getExtensions\(\)\) \{[\s\S]*?return \{\n\s+allowed: false,\n\s+kind: "extension"/);
    expect(bridgeReadme).toMatch(/bridge-local behaviour, not a guarantee about the relay as a whole/);
    expect(bridgeReadme).toMatch(/an extension registered after the bridge then rejects the message, the relay still refuses it with HTTP 403, but the memory record may already have been written/);
    expect(bridgeReadme).not.toMatch(/every message an agent submits/);
    expect(bridgeReadme).not.toMatch(/For each message the hook:/);

    // The exit handler releases the child, which clears the client and rejects
    // the pending requests, and callTool reconnects, whichever message's tool call
    // comes next, so the restart is not tied to a message boundary.
    expect(client).toMatch(/private releaseChild\(child: ChildProcess, error: Error\) \{\n\s+if \(this\.process !== child\) return;\n\s+this\.process = null;\n\s+this\.initialized = false;\n[\s\S]*?req\.reject\(error\);/);
    expect(client).toMatch(/async callTool\([^)]*\): Promise<McpToolResult> \{\n\s+if \(!this\.initialized\) await this\.connect\(\);/);
    expect(bridgeReadme).toContain("`MCP process exited`");
    expect(bridgeReadme).toMatch(/the next tool call starts a new process/);
    expect(bridgeReadme).toMatch(/can belong to the same message/);
    expect(bridgeReadme).toMatch(/on the first tool call/);
    expect(bridgeReadme).not.toMatch(/the next message starts a new process/);
    expect(bridgeReadme).not.toMatch(/on the first message after the relay starts/);

    // The root CHANGELOG bullet carries the same qualifications.
    const a3 = line(read("CHANGELOG.md"), /^- \*\*ShieldCortex bridge, MCP connector README.*$/m, "root CHANGELOG slice A3 bullet");
    expect(a3).not.toMatch(/runs on every agent-sent message/);
    expect(a3).toMatch(/stopping at the first step that rejects the message/);
    expect(a3).not.toMatch(/so a rejected message is never recorded by `remember`\)/);
    expect(a3).toMatch(/a message rejected by an extension registered after the bridge can already have been recorded/);
    expect(a3).toMatch(/not JSON is silently ignored/);
    for (const prefix of [scanPrefix, ...gatePrefixes]) expect(a3, prefix).toContain(`\`${prefix}\``);
    expect(a3).toMatch(/the next tool call, possibly for the same message, starts a new process/);
    // Failure handling is per step: the scan and action-check catches warn and
    // continue, the remember catch is empty, and each rethrow honours only its
    // own step's prefixes, so the bullet must not state one rule for all requests.
    expect(hook).toMatch(/\} catch \{\n\s+\/\/ Fire-and-forget — don't block message delivery\n\s+\}/);
    expect(a3).not.toMatch(/a request that fails because the ShieldCortex process exited, or that times out \(10 seconds per request\), is logged and fails open/);
    expect(a3).toMatch(/a scan or action-check request that fails because the ShieldCortex process exited, or that times out \(10 seconds per request\), is logged as a warning and the hook continues/);
    expect(a3).toMatch(/any failed `remember` request is silently ignored, not logged, and never rejects the message/);
    expect(a3).toContain(`the scan step rejects the message on an error whose message starts with \`${scanPrefix}\``);
    expect(a3).toContain(`the action check on one that starts with \`${gatePrefixes[0]}\` or \`${gatePrefixes[1]}\``);
    expect(a3).toMatch(/an error with the other step's prefix is logged as a warning and the hook continues/);
    expect(a3).not.toMatch(/an error whose message starts with `[^`]+`, `[^`]+` or `[^`]+` rejects the message/);
  });

  it("MCP connector README states the store's queue-full rule, which tools are idempotent, the relay floor and the version placeholder", () => {
    const readme = read("packages/mcp-connector/README.md");
    // store.ts: an unread inbound message is never evicted, and polling stops at the bound.
    const store = read("packages/mcp-connector/src/store.ts");
    expect(store).toContain("if (excess <= 0 || this.isUnread(m) || added.has(m)) return true;");
    expect(store).toMatch(/hasRoom\(\): boolean \{\n\s+return this\.unreadCount\(\) < this\.max;/);
    const queueRow = line(readme, /^\| `EKHO_MCP_QUEUE_MAX` \|.*$/m, "connector README EKHO_MCP_QUEUE_MAX row");
    expect(queueRow).not.toMatch(/oldest are dropped/i);
    expect(queueRow).toContain("an unread message is never evicted");
    expect(queueRow).toContain("stops polling the relay");
    expect(readme).not.toMatch(/drops? the oldest|oldest (?:are|is) dropped/i);
    // agent.ts: pollOnce is the caller that honours hasRoom(); it returns before the inbox fetch.
    const pollOnce = block(read("packages/mcp-connector/src/agent.ts"), /\n  async pollOnce\(\): Promise<StoredMessage\[\]> \{\n([\s\S]*?)\n  \}\n/, "agent.pollOnce");
    const roomGuard = pollOnce.indexOf("if (!this.store.hasRoom()) {");
    const inboxFetch = pollOnce.indexOf("await this.client.getInbox(");
    expect(roomGuard, "pollOnce checks hasRoom()").toBeGreaterThanOrEqual(0);
    expect(inboxFetch, "pollOnce fetches the inbox").toBeGreaterThan(roomGuard);
    expect(pollOnce.slice(roomGuard, inboxFetch)).toContain("return [];");

    // mcp.ts: ekho_send and ekho_open_room call the relay on every invocation,
    // and db.createRoom inserts a new row per call (no lookup by name).
    const mcp = read("packages/mcp-connector/src/mcp.ts");
    const sendTool = block(mcp, /server\.registerTool\(\n\s+"ekho_send",([\s\S]*?)\n  \);/, "ekho_send registration");
    expect(sendTool).toContain("await agent.send(");
    expect(sendTool).not.toMatch(/idempot/i);
    const openRoomTool = block(mcp, /server\.registerTool\(\n\s+"ekho_open_room",([\s\S]*?)\n  \);/, "ekho_open_room registration");
    expect(openRoomTool).toContain("await agent.openRoom(");
    const createRoom = block(read("packages/relay/src/db.ts"), /\n  createRoom\(([\s\S]*?)\n  \}\n/, "db.createRoom");
    expect(createRoom).toContain('const roomId = id("room");');
    expect(createRoom).toContain("INSERT INTO rooms");
    expect(createRoom).not.toMatch(/SELECT[^\n]*FROM rooms/);
    const toolsIntro = line(readme, /^Five tools,.*$/m, "connector README tools intro");
    expect(toolsIntro).not.toMatch(/all idempotent/);
    expect(toolsIntro).toContain("`ekho_roster` and `ekho_conversation` are read-only");
    expect(toolsIntro).toContain("`ekho_send` signs and sends a new message on every call");
    expect(toolsIntro).toContain("`ekho_open_room` creates a new room on every call");

    // Relay floor: 0.6.0 or later, not "0.6.x" (the connector is at the relay's version).
    expect(readJson("packages/mcp-connector/package.json").version).toBe(relayVersion);
    expect(readme).toMatch(/Ekho relay, 0\.6\.0 or later/);
    expect(readme).not.toMatch(/relay \(0\.6\.x\)/);

    // cli.ts logs the package's own version, so the sample log shows a placeholder.
    expect(read("packages/mcp-connector/src/cli.ts")).toContain("log.info(`[ekho-mcp] v${pkg.version} agent=");
    expect(readme).toContain("[ekho-mcp] v<version> agent=agent_");
    expect(readme).not.toMatch(/\[ekho-mcp\] v\d+\.\d+\.\d+/);
  });

  it("SECURITY.md supports the current major.minor line and names both native TLS variables", () => {
    const security = read("SECURITY.md");
    const [major, minor] = relayVersion.split(".");
    const table = block(security, /## Supported Versions\n([\s\S]*?)\n## /, "SECURITY.md supported-versions section");
    expect(table).toMatch(new RegExp(`^\\| ${major}\\.${minor}\\.x\\s+\\| Yes\\s+\\|$`, "m"));
    expect(table).toMatch(new RegExp(`^\\| < ${major}\\.${minor}\\s+\\| No\\s+\\|$`, "m"));
    const rows = table.split("\n").filter((l) => /^\| \d|^\| </.test(l));
    expect(rows).toHaveLength(2);

    const configTs = read("packages/relay/src/config.ts");
    expect(configTs).toContain("tlsCertPath: process.env.EKHO_TLS_CERT_PATH");
    expect(configTs).toContain("tlsKeyPath: process.env.EKHO_TLS_KEY_PATH");
    const tls = read("packages/relay/src/tls.ts");
    expect(tls).toContain("if (!certPath && !keyPath) return null;");
    expect(tls).toContain("set BOTH EKHO_TLS_CERT_PATH and EKHO_TLS_KEY_PATH, or neither.");
    const tlsBullet = line(security, /^- Terminate TLS at a reverse proxy.*$/m, "SECURITY.md TLS bullet");
    expect(tlsBullet).toContain("`EKHO_TLS_CERT_PATH`");
    expect(tlsBullet).toContain("`EKHO_TLS_KEY_PATH`");
    expect(tlsBullet).toMatch(/setting only one is a start-up error/);
    expect(tlsBullet).toMatch(/plain HTTP/);
    expect(tlsBullet).not.toMatch(/the relay itself speaks plain HTTP/);
    expect(read("docs/operations.md")).toMatch(/^## TLS$/m);
  });

  it("README API section names the routes openapi.yaml leaves out and points to docs/a2a.md for A2A", () => {
    const specPaths = new Set([...read("openapi.yaml").matchAll(/^  (\/[^\s:]*):$/gm)].map((m) => m[1]));
    expect(specPaths.has("/")).toBe(true);
    expect(specPaths.has("/healthz")).toBe(true);
    expect(read("packages/relay/src/health.ts")).toContain('app.get("/readyz"');
    expect(read("packages/relay/src/metrics.ts")).toContain('app.get("/metrics"');
    expect(read("packages/relay/src/ui-routes.ts")).toContain('prefix: "/ui/"');
    const a2aRoutes = read("packages/relay/src/a2a/routes.ts");
    const a2aDoc = read("docs/a2a.md");
    for (const route of ["/.well-known/agent-card.json", "/agents/:agentId/.well-known/agent-card.json", "/a2a", "/agents/:agentId/a2a"]) {
      expect(a2aRoutes, route).toContain(`"${route}"`);
      const specForm = route.replace(/:([A-Za-z]+)/g, "{$1}");
      expect(specPaths.has(specForm), `${specForm} is not in openapi.yaml`).toBe(false);
      expect(a2aDoc, route).toContain(specForm);
    }
    for (const missing of ["/readyz", "/metrics", "/ui", "/ui/"]) {
      expect(specPaths.has(missing), `${missing} is not in openapi.yaml`).toBe(false);
    }
    const apiIntro = block(rootReadme, /\n## API\n\n([\s\S]*?)\n\n### Agent API\n/, "README API intro");
    expect(apiIntro).not.toMatch(/full specification/i);
    expect(apiIntro).toContain("[openapi.yaml](openapi.yaml)");
    expect(apiIntro).toContain("`GET /readyz`");
    expect(apiIntro).toContain("`GET /metrics`");
    expect(apiIntro).toContain("`/ui/`");
    expect(apiIntro).toContain("[docs/a2a.md](docs/a2a.md)");
  });

  it("shipped package changelogs have no relative docs/ link and carry a dated heading for their package.json version", () => {
    const rootDate = capture(
      read("CHANGELOG.md"),
      new RegExp(`^## \\[${escapeRe(relayVersion)}\\] - (\\d{4}-\\d{2}-\\d{2})$`, "m"),
      `root CHANGELOG ${relayVersion} heading`
    );
    for (const pkg of ["sdk", "openclaw-plugin"]) {
      const changelog = read(`packages/${pkg}/CHANGELOG.md`);
      const version = readJson(`packages/${pkg}/package.json`).version;
      expect(version, `${pkg} is in lockstep`).toBe(relayVersion);
      expect(changelog, `${pkg} CHANGELOG has no relative docs/ link`).not.toMatch(/\]\(docs\//);
      expect(changelog, `${pkg} CHANGELOG has a ${version} heading`).toContain(`\n## [${version}] - ${rootDate}\n`);
    }
    expect(read("packages/sdk/CHANGELOG.md")).toContain("[Operations Guide](https://github.com/Drakon-Systems-Ltd/ekho/blob/main/docs/operations.md)");
  });
});

describe("source .env location, design-doc label, and version and naming nits match the source (#130 slice A4)", () => {
  const rootReadme = read("README.md");
  const operations = read("docs/operations.md");
  const relayReadme = read("packages/relay/README.md");
  const setupWizard = read("docs/setup-wizard.md");
  const setupTs = read("packages/relay/src/setup.ts");
  const hermesReadme = read("packages/hermes-plugin/README.md");
  const rootPkg = JSON.parse(read("package.json")) as { workspaces: string[]; scripts: Record<string, string> };

  it("docs name packages/relay/.env for a source install because dotenv reads the cwd and the root scripts run with -w", () => {
    // dotenv.config() with no path reads .env from process.cwd().
    const configTs = read("packages/relay/src/config.ts");
    expect(configTs.match(/dotenv\.config\(/g)).toHaveLength(1);
    expect(configTs).toMatch(/^dotenv\.config\(\);$/m);
    // setup.ts writes the generated secret to .env in its cwd.
    expect(setupTs).toContain('const envPath = path.join(process.cwd(), ".env");');
    expect(setupTs).not.toMatch(/repo-root/);
    // npm runs a workspace script from the workspace directory, so the root
    // scripts land in packages/relay.
    expect(rootPkg.workspaces).toEqual(["packages/*"]);
    expect(JSON.parse(read("packages/relay/package.json")).name).toBe("@ekho/relay");
    for (const script of ["start", "dev", "setup"]) {
      expect(rootPkg.scripts[script], `root ${script} script`).toBe(`npm run ${script} -w @ekho/relay`);
    }
    // Compose reads the root .env only for interpolation: no env_file.
    const compose = read("docker-compose.yml");
    expect(compose).toContain("${EKHO_OPERATOR_SESSION_SECRET");
    expect(compose).not.toMatch(/env_file/);

    for (const [label, doc] of [["README", rootReadme], ["operations.md", operations], ["relay README", relayReadme]] as const) {
      const note = capture(doc, /^\*\*Which `\.env`:\*\*(.*)$/m, `${label} .env note`);
      expect(note, label).toContain("from source, the relay reads `packages/relay/.env`");
      expect(note, label).toContain("`npm run setup` saves a generated operator secret");
      expect(note, label).toContain("`-w @ekho/relay`");
      expect(note, label).toContain("`dotenv.config()` with no path");
      expect(note, label).toContain("it is for Docker Compose");
      expect(note, label).toContain("`${EKHO_OPERATOR_SESSION_SECRET}`");
    }
    expect(rootReadme).toContain("set `packages/relay/.env` (an operator session secret");
    expect(relayReadme).toContain("set `packages/relay/.env` (an operator session secret");
    expect(setupWizard).toContain("`packages/relay/.env` under `npm run setup`");
  });

  it("ARCHITECTURE.md is labelled a design document naming the unbuilt CLI, PostgreSQL and Tailscale wizard", () => {
    // The claims in the label, checked against the code.
    const bins = fs
      .readdirSync(path.join(root, "packages"))
      .filter((dir) => fs.existsSync(path.join(root, "packages", dir, "package.json")))
      .flatMap((dir) => Object.keys((JSON.parse(read(`packages/${dir}/package.json`)).bin ?? {}) as Record<string, string>));
    expect(bins).toEqual(["ekho-mcp"]);
    for (const dir of fs.readdirSync(path.join(root, "packages"))) {
      const manifest = path.join("packages", dir, "package.json");
      if (!fs.existsSync(path.join(root, manifest))) continue;
      expect(read(manifest), manifest).not.toMatch(/"(?:pg|postgres|pg-promise)"/);
    }
    expect(setupTs).not.toMatch(/tailscale/i);

    const architecture = read("ARCHITECTURE.md");
    const label = capture(architecture, /^# Ekho Architecture\n\n> (\*\*Design document\.\*\*.*)$/m, "ARCHITECTURE.md label");
    expect(label).toContain("not implemented in the current code");
    expect(label).toContain("there is no `ekho` CLI");
    expect(label).toContain("`ekho-mcp`");
    expect(label).toContain("There is no PostgreSQL support");
    expect(label).toContain("there is no Tailscale setup wizard");

    expect(rootReadme).toContain("the design document [ARCHITECTURE.md](ARCHITECTURE.md), which also describes planned components that are not implemented");
    expect(rootReadme).not.toMatch(/deep-dive/);

    expect(setupWizard).toContain("## What `npm run setup` does");
    expect(setupWizard).toContain("## Not implemented: Tailscale-aware setup");
    expect(setupWizard).toContain("**None of that is implemented**");
    expect(setupWizard).not.toMatch(/the wizard should/);
    // The setup steps the doc lists are the ones runSetup() performs.
    const runSetup = capture(setupTs, /function runSetup\(\) \{([\s\S]*?)\n\}/, "runSetup");
    for (const step of ["loadLicense()", "ensureOperatorSecret()", 'db.findFleetByName("default")', "assertFleetCreationAllowed(", "db.createBootstrap(", "db.issueEnrollmentToken("]) {
      expect(runSetup, step).toContain(step);
    }
    expect(setupWizard).toContain("a fleet named `default` already exists");
    expect(setupWizard).toContain("Issues one enrollment token");
  });

  it("version nits: 0.5.6-and-later wording and the Dockerfile fix version from the CHANGELOG", () => {
    const pluginReadme = read("packages/openclaw-plugin/README.md");
    expect(rootReadme).not.toMatch(/The 0\.5\.6 plugin/);
    expect(pluginReadme).not.toMatch(/The 0\.5\.6 code/);
    expect(rootReadme).toContain("The plugin (0.5.6 and later) has no supported operator-key seed setting");
    expect(pluginReadme).toContain("The plugin code (0.5.6 and later) also reads `allowNewIdentity`");

    const changelog = read("CHANGELOG.md");
    const fixVersion = capture(
      changelog,
      /^## \[([0-9.]+)\] - [0-9-]+\n(?:(?!^## \[)[\s\S])*?The Docker image build fails when the console build fails/m,
      "CHANGELOG release with the Dockerfile ui:build fix"
    );
    expect(operations).toContain(`since ${fixVersion} a failed console build fails the image build`);
    expect(operations).not.toMatch(/since 0\.5\.6 a failed console build/);
  });

  it("Hermes README uses the real plugin name and link, and the docs do not claim the Python packages version in lockstep", () => {
    expect(rootReadme).toContain("[`ekho_hermes`](packages/hermes-plugin/)");
    expect(fs.existsSync(path.join(root, "packages/hermes-plugin/ekho_hermes"))).toBe(true);
    const manifest = read("packages/hermes-plugin/ekho_hermes/plugin.yaml");
    expect(capture(manifest, /^name:\s*(.+)$/m, "plugin.yaml name")).toBe("ekho");
    expect(hermesReadme.split("\n")[0]).toBe("# Ekho Hermes plugin (`ekho_hermes`)");
    expect(hermesReadme).toContain("under the plugin name `ekho`");
    expect(hermesReadme).not.toContain("](https://github.com/)");
    const hermesRepo = capture(read(".github/workflows/ci.yml"), /^\s*repository:\s*(\S*hermes-agent)$/m, "CI hermes-agent repository");
    expect(hermesReadme).toContain(`[Hermes](https://github.com/${hermesRepo})`);

    // plugin.yaml and pyproject.toml carry their own versions; the release
    // number is the relay's. The README must not imply they move together.
    const relayVersion = JSON.parse(read("packages/relay/package.json")).version as string;
    const pluginVersion = capture(manifest, /^version:\s*(.+)$/m, "plugin.yaml version");
    const pythonVersion = capture(read("sdks/python/pyproject.toml"), /^version\s*=\s*(.+)$/m, "pyproject version");
    const status = capture(rootReadme, /^## Project Status\n\n(.*)$/m, "Project Status");
    if (pluginVersion !== relayVersion || pythonVersion !== relayVersion) {
      expect(status).toContain("keep their own version numbers");
      expect(status).toContain("do not move with the Ekho release number");
    }

    // The bundle log line's version= is plugin.yaml's version: line.
    const bundleIdentity = read("packages/hermes-plugin/ekho_hermes/bundle_identity.py");
    expect(bundleIdentity).toContain('yaml_path = root / "plugin.yaml"');
    expect(bundleIdentity).toContain('if stripped.startswith("version:"):');
    expect(bundleIdentity).toContain("version=plugin_version(root),");
    expect(hermesReadme).toContain("Compare the hash, not `version=`");
    expect(hermesReadme).toContain("does not follow the\n#    Ekho release number");
  });

  it("Python SDK README says the methods are snake_case equivalents", () => {
    const pyClient = read("sdks/python/ekho/client.py");
    const nodeClient = read("packages/sdk/src/client.ts");
    expect(pyClient).toContain("def send_message(");
    expect(nodeClient).toMatch(/^  sendMessage\(/m);
    expect(pyClient).toContain("def get_inbox(");
    expect(nodeClient).toMatch(/^  getInbox\(/m);
    const pyReadme = read("sdks/python/README.md");
    expect(pyReadme).not.toMatch(/same method names/);
    expect(pyReadme).toContain("snake_case equivalents");
    expect(pyReadme).toContain("`send_message` for `sendMessage`");
  });

  it("writer-reviewer example uses the real agent id format, console button label and package status", () => {
    expect(read("packages/relay/src/db.ts")).toContain('const agentId = `agent_${id("agt").slice(-12)}`;');
    expect(read("packages/relay/src/utils.ts")).toContain('return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;');
    expect(read("packages/relay/frontend/src/App.jsx")).toContain(">Mint enrollment token</button>");

    const example = read("examples/writer-reviewer/README.md");
    expect(example).not.toMatch(/agt_/);
    const ids = [...example.matchAll(/\bagent_[0-9a-z]+/g)].map((m) => m[0]).filter((id) => id !== "agent_");
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^agent_[0-9a-f]{12}$/);
    expect(example).toContain("**Mint enrollment token**");
    expect(example).not.toMatch(/Enroll Agent/);

    expect(rootPkg.workspaces).toEqual(["packages/*"]);
    expect(example).not.toMatch(/workspace package/i);
    expect(example).toContain("It is not an npm workspace");
  });

  it("CONTRIBUTING lists every package directory, has no drifting test count and links the real repo; README names Vitest", () => {
    const contributing = read("CONTRIBUTING.md");
    const structure = capture(contributing, /^## Project Structure\n\n```\n([\s\S]*?)```/m, "CONTRIBUTING structure");
    const packageDirs = fs
      .readdirSync(path.join(root, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const dir of packageDirs) expect(structure, dir).toMatch(new RegExp(`^  ${dir}/ `, "m"));
    expect(fs.existsSync(path.join(root, "sdks/python/pyproject.toml"))).toBe(true);
    expect(structure).toMatch(/^sdks\/\n  python\/ /m);
    expect(contributing).not.toMatch(/\d+\+? tests/);
    expect(contributing).not.toContain("DrakonSystems/ekho");
    expect(contributing).toContain("[github.com/Drakon-Systems-Ltd/ekho/issues](https://github.com/Drakon-Systems-Ltd/ekho/issues)");

    expect(rootPkg.scripts.test).toBe("vitest run");
    expect(rootReadme).not.toMatch(/Node test suite/);
    expect(rootReadme).toMatch(/^npm test +# Vitest suite/m);
  });
});

// #130 slice A5: Pro is described as the code implements it today (the fleet
// limit in license.ts), and the OpenAPI licence matches the repo LICENSE.
describe("Pro tier copy and OpenAPI licence match the source (#130 slice A5)", () => {
  const rootReadme = read("README.md");

  it("Pro copy names only the fleet limit the licence gates; planned features are marked planned", () => {
    const license = read("packages/relay/src/license.ts");
    expect(capture(license, /const OSS_LICENSE[^}]*?max_fleets:\s*(\d+)/s, "OSS max_fleets")).toBe("1");
    expect(license).toContain("Upgrade to Pro for multi-fleet support.");
    expect(read("packages/relay/src/setup.ts")).toContain("assertFleetCreationAllowed(fleetCount)");

    const openCore = capture(rootReadme, /^- \*\*Open-core licensing\*\* — (.+)$/m, "README open-core bullet");
    expect(openCore).toContain("Pro tier for multi-fleet");
    expect(openCore).toContain("`max_fleets` 1");
    expect(openCore).not.toMatch(/Pro tier for[^.]*(advanced polic|analytics)/i);
    expect(openCore).toMatch(/Advanced policies and an analytics dashboard are planned, not available today/);

    const pricing = rootReadme.slice(rootReadme.indexOf("## Pricing"), rootReadme.indexOf("## Development"));
    expect(pricing).toMatch(/^\| \*\*Multi-fleet \/ multi-tenant\*\* \| — \| Yes \|$/m);
    expect(pricing).toMatch(/^\| \*\*Advanced policies\*\* \| — \| Planned \|$/m);
    expect(pricing).toMatch(/^\| \*\*Analytics dashboard\*\* \| — \| Planned \|$/m);
    expect(pricing).toMatch(/^\| Policy engine \| Basic \(deny\/allow\) \| Basic \(deny\/allow\) \|$/m);
    expect(pricing).toContain("The fleet limit is the only thing the licence tier gates");

    const performance = read("docs/performance.md");
    expect(performance).not.toMatch(/PostgreSQL \(Pro/);
    expect(performance).toContain("PostgreSQL support is planned, not available in any tier");
    expect(read("packages/relay/src/db.ts")).toContain('from "better-sqlite3"');

    for (const [name, text] of [["README.md", rootReadme], ["docs/performance.md", performance]] as const) {
      expect(text, name).not.toMatch(/Pro tier for[^.\n]*(postgres|advanced polic|analytics)/i);
    }
  });

  it("openapi.yaml info.license is MIT, matching LICENSE", () => {
    expect(read("LICENSE").split("\n")[0].trim()).toBe("MIT License");
    const spec = read("openapi.yaml");
    const license = capture(spec, /^info:\n(?:[ \t].+\n)*?([ \t]+license:\n(?:[ \t]{4,}.+\n)+)/m, "OpenAPI info.license");
    expect(license).toMatch(/^\s+name: MIT$/m);
    expect(license).toMatch(/url: https:\/\/opensource\.org\/licenses\/MIT$/m);
    expect(spec).not.toMatch(/Proprietary/);
  });
});
