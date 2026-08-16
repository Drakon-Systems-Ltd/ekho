import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
 * Stage a bundle somewhere it can be imported: the host provides `openclaw` at
 * load time (build.mjs marks it external), so stand up a minimal stub of the
 * one SDK entry point the plugin imports.
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
  const entry = path.join(dir, "index.mjs");
  fs.writeFileSync(entry, source);
  return entry;
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
async function startPlugin(entry: string) {
  const lines: string[] = [];
  const record = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  const home = process.env.HOME;
  process.env.HOME = tmpDir();
  try {
    const mod = await import(pathToFileURL(entry).href);
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

describe("the built bundle carries its own identity", () => {
  let dist = "";

  beforeAll(() => {
    // Build for real — a stamp that only exists in the test's imagination is
    // exactly the failure mode under repair.
    execFileSync("node", ["build.mjs"], { cwd: PKG_DIR, stdio: "pipe" });
    dist = fs.readFileSync(DIST, "utf-8");
  }, 120_000);

  afterAll(() => {
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    tmpDirs.length = 0;
  });

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
