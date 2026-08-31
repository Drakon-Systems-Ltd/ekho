import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PKG_DIR = path.join(__dirname, "..");
const DIST = path.join(PKG_DIR, "dist", "index.js");

/**
 * ekho#33 end-to-end: these run against a REAL bundle produced by build.mjs and
 * loaded by a REAL process, because that is the only place the claim can be
 * tested. The pure helpers are covered in build-stamp.test.ts; what is proved
 * here is that the artifact on disk carries its identity and that a process
 * loading it says so out loud — including when the artifact has been edited
 * underneath it, which is the case this whole change exists for.
 */

const tmpDirs: string[] = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-bundle-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Stage a bundle somewhere it can be imported, and hand back the directory: the
 * host provides `openclaw` at load time (build.mjs marks it external), so stand
 * up a minimal stub of the one SDK entry point the plugin imports.
 */
function stageBundle(source: string): string {
  const dir = tmpDir();
  const sdkDir = path.join(dir, "node_modules", "openclaw", "plugin-sdk");
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "node_modules", "openclaw", "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "0.0.0-test-stub",
      type: "module",
      exports: { "./plugin-sdk/tool-plugin": "./plugin-sdk/tool-plugin.js" }
    })
  );
  fs.writeFileSync(
    path.join(sdkDir, "tool-plugin.js"),
    // Mirrors the host: collect the tool definitions, hand back an entry whose
    // register() the gateway calls at startup.
    "export function defineToolPlugin(def) {\n" +
      "  const tools = def.tools((t) => t);\n" +
      "  return { ...def, tools, register(api) { api.__registeredTools = tools; } };\n" +
      "}\n"
  );
  fs.writeFileSync(path.join(dir, "index.mjs"), source);
  return dir;
}

/**
 * Load a staged bundle and run the startup path the gateway runs, capturing its
 * log.
 *
 * HOME is redirected at the door. The plugin resolves its credential directory
 * from os.homedir(), so without this a test run on a live box would load that
 * box's real agent identity and start talking to the production relay as it.
 * Every test here needs only the bytes on disk, so it gets an empty home.
 */
async function startPlugin(dir: string) {
  const lines: string[] = [];
  const record = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  const home = process.env.HOME;
  process.env.HOME = tmpDir();
  try {
    const mod = await import(pathToFileURL(path.join(dir, "index.mjs")).href);
    // No relayBaseUrl: startup must still identify itself, so a box that never
    // connects is still answerable.
    mod.default.register({ pluginConfig: {}, logger: { info: record, warn: record, error: record, debug: record } });
    return { lines, plugin: mod.default, home: process.env.HOME };
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
}

/** Read the build field off ekho_inbox, with the same home isolation. */
async function inboxBuildField(plugin: { tools: Array<{ name: string; execute: Function }> }, home: string) {
  const inbox = plugin.tools.find((t) => t.name === "ekho_inbox");
  expect(inbox, "ekho_inbox not registered").toBeTruthy();
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    // Pre-provisioned credentials + an unroutable relay: the tool connects
    // without enrolling and without reaching anything real.
    const config = { relayBaseUrl: "http://127.0.0.1:9", agentId: "test-agent", agentSecret: "test-secret" };
    const result = (await inbox!.execute({}, config, {})) as { build: Record<string, unknown> };
    return result.build;
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

const buildLine = (lines: string[]) => lines.find((l) => l.startsWith("[ekho-build]"));

/**
 * One real build for the whole file. Both suites below need the same artifact,
 * and build.mjs clears dist/ before writing it, so a second suite building its
 * own copy in a parallel worker would pull dist out from under this one.
 */
let dist = "";

beforeAll(() => {
  // Build for real — a stamp that only exists in the test's imagination is
  // exactly the failure mode under repair. process.execPath, not "node": the
  // build must run under the interpreter running the tests, not whatever PATH
  // happens to resolve.
  execFileSync(process.execPath, ["build.mjs"], { cwd: PKG_DIR, stdio: "pipe" });
  dist = fs.readFileSync(DIST, "utf-8");
}, 120_000);

afterAll(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
});

describe("the built bundle carries its own identity", () => {
  it("stamps dist with a well-formed version, commit, build time and digest", () => {
    // Before this change the same grep over dist returned nothing at all: the
    // version lived only in package.json, beside the bundle rather than in it.
    const m = /const __EKHO_BUILD__ = (\{.*?\});/.exec(dist);
    expect(m, "no __EKHO_BUILD__ stamp in dist/index.js").toBeTruthy();
    const stamp = JSON.parse(m![1]);

    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf-8"));
    expect(stamp.version).toBe(pkg.version);
    expect(stamp.commit).toMatch(/^([0-9a-f]{40}(-dirty)?|unknown)$/);
    expect(stamp.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(stamp.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("leaves no unfilled digest slot behind", () => {
    expect(dist).not.toContain("0".repeat(64));
  });

  it("reports itself intact when a process loads it untouched", async () => {
    const { lines } = await startPlugin(stageBundle(dist));
    const line = buildLine(lines);
    expect(line, `no build line in: ${JSON.stringify(lines)}`).toBeTruthy();
    expect(line).toMatch(
      /^\[ekho-build\] version=\d+\.\d+\.\d+ commit=([0-9a-f]{40}(-dirty)?|unknown) built=\S+ artifact=sha256:[0-9a-f]{16} \(intact\)$/
    );
  });

  it("exposes the same identity on a tool result, so an agent can read it without the journal", async () => {
    const { plugin, home } = await startPlugin(stageBundle(dist));
    const build = await inboxBuildField(plugin, home);
    expect(build).toMatchObject({ artifact: "intact", source: "bundle" });
    expect(build.running_sha256).toBe(build.built_sha256);
    expect(build.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("still answers the build question on a box that cannot reach its relay", async () => {
    // Asking every box its version is how a security posture gets established,
    // so the answer must not depend on the relay being up.
    const { plugin, home } = await startPlugin(stageBundle(dist));
    const inbox = plugin.tools.find((t: { name: string }) => t.name === "ekho_inbox");
    const prev = process.env.HOME;
    process.env.HOME = home; // empty home: no saved credentials to fall back on
    try {
      // No relayBaseUrl and no credentials — connection cannot succeed.
      const result = (await inbox.execute({}, {}, {})) as {
        build: Record<string, unknown>;
        error?: string;
      };
      expect(result.error).toMatch(/not connected/);
      expect(result.build).toMatchObject({ artifact: "intact", source: "bundle" });
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
  });

  // THE case. On this fleet dist is hand-patched in place and package.json is
  // left alone, so the reported version keeps describing code that is no longer
  // there. A stamp alone would inherit that defect verbatim — it would sit in
  // the patched bundle still asserting the old release. The digest is what makes
  // the difference, so it is tested against a genuinely patched artifact.
  describe("a hand-patched bundle stops claiming to be the build it was", () => {
    const PATCH_TARGET = "[ekho-autoreply] listening for inbound (poll ";

    it("says MODIFIED at startup, while the stamp itself is unchanged", async () => {
      expect(dist).toContain(PATCH_TARGET);
      // Same length, one letter different: the kind of edit no size or mtime
      // check would catch, and mtime was already disproved as a signal here.
      const patched = dist.replace(PATCH_TARGET, "[ekho-autoreply] listening for inbound (POLL ");
      expect(patched).not.toBe(dist);
      expect(patched.length).toBe(dist.length);

      const clean = await startPlugin(stageBundle(dist));
      const dirty = await startPlugin(stageBundle(patched));

      const cleanLine = buildLine(clean.lines)!;
      const dirtyLine = buildLine(dirty.lines)!;

      expect(cleanLine).toContain("(intact)");
      expect(dirtyLine).toContain("MODIFIED — dist was edited after build");

      // The stamped fields are byte-identical across the two — which is the
      // point: version and commit alone cannot tell these two boxes apart.
      const fields = (l: string) => /version=(\S+) commit=(\S+) built=(\S+)/.exec(l)!.slice(1, 4).join(" ");
      expect(fields(dirtyLine)).toBe(fields(cleanLine));
      // The digest can, and does.
      const artifactOf = (l: string) => /artifact=sha256:([0-9a-f]+)/.exec(l)![1];
      expect(artifactOf(dirtyLine)).not.toBe(artifactOf(cleanLine));
    });

    it("reports the patch on the tool surface too", async () => {
      const patched = dist.replace(PATCH_TARGET, "[ekho-autoreply] listening for inbound (POLL ");
      const { plugin, home } = await startPlugin(stageBundle(patched));
      const build = await inboxBuildField(plugin, home);
      expect(build.artifact).toBe("modified");
      expect(build.running_sha256).not.toBe(build.built_sha256);
    });

    it("says so, rather than guessing, when the stamp has been stripped out entirely", async () => {
      // Reverting a box to a pre-#33 bundle, or deleting the banner by hand:
      // there is nothing left to identify it with, and it must not quietly fall
      // back to whatever package.json happens to say.
      const stripped = dist.replace(/const __EKHO_BUILD__ = \{.*?\};\n/, "");
      expect(stripped).not.toContain("const __EKHO_BUILD__ =");
      const { lines } = await startPlugin(stageBundle(stripped));
      const line = buildLine(lines)!;
      expect(line).toContain("carries no build stamp");
      expect(line).toContain("version=unknown");
    });

    it("catches a bundle whose stamp was relabelled to a different version", async () => {
      // "Just edit the version in dist" is the shortcut this must not reward.
      const stamp = /const __EKHO_BUILD__ = (\{.*?\});/.exec(dist)![1];
      const relabelled = dist.replace(stamp, stamp.replace(/"version":"[^"]+"/, '"version":"9.9.9"'));
      const { lines } = await startPlugin(stageBundle(relabelled));
      const line = buildLine(lines)!;
      expect(line).toContain("version=9.9.9");
      expect(line).toContain("MODIFIED");
    });

    it("catches an appended patch, and even a whitespace-only edit", async () => {
      const appended = await startPlugin(stageBundle(`${dist}\n// hot patch 2026-08-16\n`));
      expect(buildLine(appended.lines)).toContain("MODIFIED");

      // Nothing about the behaviour changes here — the digest still notices,
      // so "I only reformatted it" is not a way past the check.
      const respaced = await startPlugin(stageBundle(`${dist.trimEnd()}\n\n`));
      expect(buildLine(respaced.lines)).toContain("MODIFIED");
    });
  });

  it("carries the build onto the autoreply listening line as well", () => {
    // One `journalctl | grep` for the listener line answers both "how often does
    // it poll" and "which bundle is polling".
    expect(dist).toContain("build=${");
    expect(dist).toMatch(/listening for inbound \(poll \$\{[^}]+\}ms\)/);
  });
});

/**
 * Import the staged bundle from a bare `node` process and report what happened.
 *
 * The gateway loads the extension with a plain ESM import in its own process.
 * Importing it from inside vitest does not reproduce that: vitest's module
 * runner leaves an ambient `require` in scope, which is precisely why the suite
 * above stayed green through two releases that could not load anywhere else.
 * So the import happens in a child `process.execPath` — a real ESM loader, no
 * shims — and HOME is redirected for the same reason it is above.
 */
function loadInChild(dir: string) {
  // Imported through the same loader as the bundle, so "the bundle got no
  // ambient require" is measured rather than assumed.
  fs.writeFileSync(path.join(dir, "probe.mjs"), 'export const ambientRequire = typeof require !== "undefined";\n');
  fs.writeFileSync(
    path.join(dir, "load.mjs"),
    // The gateway's startup path: import the extension, then register it.
    'const probe = await import("./probe.mjs");\n' +
      'const mod = await import("./index.mjs");\n' +
      "const plugin = mod.default;\n" +
      "const logged = [];\n" +
      'const record = (...a) => logged.push(a.map(String).join(" "));\n' +
      "plugin.register({ pluginConfig: {}, logger: { info: record, warn: record, error: record, debug: record } });\n" +
      "console.log(JSON.stringify({\n" +
      "  ambientRequire: probe.ambientRequire,\n" +
      "  tools: plugin.tools.map((t) => t.name),\n" +
      "  logged\n" +
      "}));\n"
  );
  const run = spawnSync(process.execPath, ["load.mjs"], {
    cwd: dir,
    env: { ...process.env, HOME: tmpDir() },
    encoding: "utf8"
  });
  let report: { ambientRequire?: boolean; tools?: string[]; logged?: string[] } = {};
  try {
    report = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    /* the load failed before it could report; the assertions below say so */
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, report };
}

/**
 * ekho#68: the bundle must import under a real ESM loader.
 *
 * 0.4.5 and 0.4.6 shipped a bundle that OpenClaw 2026.8.1 refused at load time:
 *
 *     Error: Dynamic require of "node:crypto" is not supported
 *
 * so the plugin sat at status=error on every box on the 2.0 gateway. The bundle
 * is ESM, but the Ekho SDK resolved to its CommonJS build, and esbuild lowered
 * that build's `require("node:crypto")` to its own `__require` shim — which
 * throws unless the loader happens to leave an ambient `require` in scope. It
 * runs at the top of the module, so the entire import dies, not just the code
 * path that hashes.
 */
describe("the built bundle imports under a real ESM loader", () => {
  let load: ReturnType<typeof loadInChild>;

  beforeAll(() => {
    load = loadInChild(stageBundle(dist));
  }, 60_000);

  it("imports without a dynamic require the loader cannot honour", () => {
    // The exact failure reported from the fleet on OpenClaw 2026.8.1.
    expect(load.stderr).not.toMatch(/Dynamic require of "[^"]+" is not supported/);
    expect(load.status, `node exited ${load.status}\n${load.stderr}`).toBe(0);
  });

  it("was loaded by a process that supplies no ambient require", () => {
    // Keeps the test above honest: under vitest this would be `true`, which is
    // how a bundle that could not load anywhere else kept a green suite.
    expect(load.report.ambientRequire, `child did not report back\n${load.stderr}`).toBe(false);
  });

  it("registers its tools once that import succeeds", () => {
    expect(load.report.tools).toEqual(["ekho_send", "ekho_open_room", "ekho_inbox"]);
    expect(load.report.logged?.join("\n")).toContain("[ekho-adapter] registered tools:");
  });

  it("carries no CommonJS require shim at all", () => {
    // The property rather than the one symptom: a CommonJS dependency added
    // later brings the shim back, and it should fail here rather than on a
    // fleet box. Reported as the offending lines — a whole-bundle diff is
    // unreadable.
    const shim = dist
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => line.includes("Dynamic require of") || /\b__require\b/.test(line))
      .map(([n, line]) => `${n}: ${line.trim()}`);
    expect(shim, "esbuild lowered a require() into the bundle").toEqual([]);
  });
});

/**
 * The bundle inlines the Ekho SDK, and the SDK ships only what its `files` list
 * publishes. A build that reaches for something outside that list works in this
 * checkout and nowhere else — and it would take the fix for the load failure
 * above down with it, since that fix is about which SDK build gets inlined. So
 * the published layout is checked against the artifact rather than assumed.
 */
describe("the built bundle inlines only SDK files the SDK publishes", () => {
  it("resolves every inlined SDK module inside `npm pack`'s file list", () => {
    // Resolved from the plugin package the way esbuild resolves it, not by
    // assuming a sibling directory: in an installed layout the SDK is under
    // node_modules, and the check has to hold there too.
    const sdkDir = fs.realpathSync(
      path.dirname(createRequire(path.join(PKG_DIR, "package.json")).resolve("@drakon-systems/ekho-sdk/package.json"))
    );
    const real = (p: string) => {
      try { return fs.realpathSync(p); } catch { return p; }
    };

    // esbuild labels each inlined module with its path relative to the build's
    // working directory, which is the plugin package.
    const inlinedSdkFiles = [...dist.matchAll(/^\/\/ (\S+\.(?:js|mjs|cjs|ts))$/gm)]
      .map((m) => real(path.resolve(PKG_DIR, m[1])))
      .filter((abs) => abs.startsWith(`${sdkDir}${path.sep}`))
      .map((abs) => path.relative(sdkDir, abs).split(path.sep).join("/"));
    expect(inlinedSdkFiles.length, "no SDK module inlined — the bundle stopped using the SDK?").toBeGreaterThan(0);

    const packed: string[] = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "-w", "@drakon-systems/ekho-sdk"], {
        cwd: path.join(PKG_DIR, "..", ".."),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      })
    )[0].files.map((f: { path: string }) => f.path);

    expect(packed.length, "npm pack listed no files").toBeGreaterThan(0);
    const unpublished = inlinedSdkFiles.filter((f) => !packed.includes(f));
    expect(unpublished, `inlined SDK files missing from the published tarball; packed: ${packed.join(", ")}`).toEqual(
      []
    );
  });
});
