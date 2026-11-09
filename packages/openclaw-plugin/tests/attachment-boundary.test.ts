import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANCHORED_OPEN_SUPPORTED, readUploadFile, resolveOutboxDir } from "../src/attachments";

/**
 * ekho_send attachments come only from the outbox directory, checked on the
 * real path; the plugin/OpenClaw/Hermes state dirs and the identity,
 * credential and config file names are refused outright. Every path here is a
 * scratch HOME; the real ~/.openclaw is never touched.
 */
let home = "";
let ocDir = "";
let stateDir = "";
let outbox = "";
let outside = "";

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "ekho-outbox-home-")));
  ocDir = join(home, ".openclaw");
  stateDir = join(ocDir, "ekho-adapter");
  outbox = join(home, "ekho-outbox");
  outside = join(home, "elsewhere");
  for (const d of [stateDir, outbox, outside]) mkdirSync(d, { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", ocDir);
  vi.stubEnv("EKHO_STATE_DIR", "");
  vi.stubEnv("EKHO_OUTBOX_DIR", "");
  vi.stubEnv("HERMES_HOME", "");
  writeFileSync(join(stateDir, ".ekho-identity.json"), JSON.stringify({ seedHex: "ab".repeat(32) }));
  writeFileSync(join(stateDir, ".ekho-credentials.json"), JSON.stringify({ agentId: "a", secret: "s3cret" }));
  writeFileSync(join(ocDir, "openclaw.json"), JSON.stringify({ token: "provider-key" }));
  writeFileSync(join(outside, "notes.txt"), "outside the outbox");
  writeFileSync(join(outbox, "report.md"), "# report\n");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const cfg = () => ({ stateDir, outboxDir: outbox });
const refused = (p: string, config: { stateDir?: string; outboxDir?: string } = cfg()) => {
  let err: Error | undefined;
  try {
    readUploadFile(p, config);
  } catch (e) {
    err = e as Error;
  }
  expect(err, `expected ${p} to be refused`).toBeInstanceOf(Error);
  return err!.message;
};

describe("readUploadFile outbox boundary", () => {
  it("uploads a file inside the outbox, by absolute or outbox-relative path", () => {
    const abs = readUploadFile(join(outbox, "report.md"), cfg());
    expect(abs).toMatchObject({ mime: "text/markdown", filename: "report.md" });
    expect(abs.bytes.toString()).toBe("# report\n");
    mkdirSync(join(outbox, "sub"));
    writeFileSync(join(outbox, "sub", "data.csv"), "a,b\n");
    expect(readUploadFile("sub/data.csv", cfg()).bytes.toString()).toBe("a,b\n");
  });

  it("refuses the plugin's identity file", () => {
    const msg = refused(join(stateDir, ".ekho-identity.json"));
    expect(msg).toContain(outbox);
    expect(msg).not.toContain("ab".repeat(32));
  });

  it("refuses the plugin's credentials file", () => {
    expect(refused(join(stateDir, ".ekho-credentials.json"))).not.toContain("s3cret");
  });

  it("refuses openclaw.json", () => {
    refused(join(ocDir, "openclaw.json"));
  });

  it("refuses ../ traversal out of the outbox", () => {
    refused("../elsewhere/notes.txt");
    refused(join(outbox, "..", "elsewhere", "notes.txt"));
    refused(join(outbox, "..", ".openclaw", "ekho-adapter", ".ekho-identity.json"));
  });

  it("refuses an absolute path outside the outbox", () => {
    expect(refused(join(outside, "notes.txt"))).toContain(outbox);
  });

  it("refuses a symlink inside the outbox that points out, without naming its target", () => {
    symlinkSync(join(stateDir, ".ekho-identity.json"), join(outbox, "innocent.json"));
    symlinkSync(join(outside, "notes.txt"), join(outbox, "notes.txt"));
    const msg = refused(join(outbox, "innocent.json"));
    expect(msg).not.toContain(stateDir);
    expect(msg).not.toContain(".ekho-identity.json");
    refused("notes.txt");
  });

  it("refuses a file under a symlinked directory inside the outbox", () => {
    symlinkSync(stateDir, join(outbox, "state"));
    symlinkSync(outside, join(outbox, "away"));
    refused(join(outbox, "state", ".ekho-credentials.json"));
    refused("away/notes.txt");
  });

  it("refuses an outbox whose symlinked parent lands in the state dir", () => {
    mkdirSync(join(stateDir, "outbox"));
    writeFileSync(join(stateDir, "outbox", "x.txt"), "x");
    symlinkSync(stateDir, join(home, "linked"));
    const sneaky = join(home, "linked", "outbox");
    refused(join(sneaky, "x.txt"), { stateDir, outboxDir: sneaky });
  });

  it("refuses an outbox that is, contains, or sits inside a state/config dir", () => {
    const hermes = join(home, ".hermes");
    mkdirSync(join(hermes, "out"), { recursive: true });
    writeFileSync(join(hermes, "out", "x.txt"), "x");
    writeFileSync(join(stateDir, "x.txt"), "x");
    writeFileSync(join(home, "x.txt"), "x");
    refused(join(stateDir, ".ekho-identity.json"), { stateDir, outboxDir: stateDir });
    refused(join(stateDir, "x.txt"), { stateDir, outboxDir: stateDir });
    refused(join(ocDir, "openclaw.json"), { stateDir, outboxDir: ocDir });
    refused(join(hermes, "out", "x.txt"), { stateDir, outboxDir: join(hermes, "out") });
    refused(join(home, "x.txt"), { stateDir, outboxDir: home }); // home contains ~/.openclaw
    refused(join(home, "x.txt"), { stateDir, outboxDir: "/" });
  });

  it("refuses identity/credential file names and dotfiles even inside the outbox", () => {
    copyFileSync(join(stateDir, ".ekho-identity.json"), join(outbox, ".ekho-identity.json"));
    copyFileSync(join(stateDir, ".ekho-credentials.json"), join(outbox, "credentials.json"));
    writeFileSync(join(outbox, "identity.json"), "{}");
    writeFileSync(join(outbox, "openclaw.json"), "{}");
    writeFileSync(join(outbox, ".hidden.txt"), "x");
    for (const n of [".ekho-identity.json", "credentials.json", "identity.json", "openclaw.json", ".hidden.txt"]) {
      refused(join(outbox, n));
    }
  });

  it("keeps the extension allow-list inside the outbox", () => {
    writeFileSync(join(outbox, "run.sh"), "echo");
    expect(refused(join(outbox, "run.sh"))).toMatch(/unsupported type/);
  });

  it("refuses a missing outbox file with an error naming only the outbox", () => {
    expect(refused("missing.txt")).toContain(outbox);
  });

  it("outboxDir config beats EKHO_OUTBOX_DIR beats ~/ekho-outbox", () => {
    const fromEnv = join(home, "env-outbox");
    expect(resolveOutboxDir({})).toBe(join(home, "ekho-outbox"));
    vi.stubEnv("EKHO_OUTBOX_DIR", fromEnv);
    expect(resolveOutboxDir({})).toBe(fromEnv);
    expect(resolveOutboxDir({ outboxDir: outside })).toBe(outside);
    mkdirSync(fromEnv);
    writeFileSync(join(fromEnv, "e.txt"), "env");
    expect(readUploadFile("e.txt", { stateDir }).bytes.toString()).toBe("env");
  });

  // The next tests check the open itself as well as the path checks: the
  // directory layout is changed deterministically from inside the helper's own
  // fs calls, and the file must still be refused.
  const PRIVATE = "PRIVATE_FIXTURE_ONLY";
  const plantSwap = () => {
    mkdirSync(join(outbox, "sub"));
    writeFileSync(join(outbox, "sub", "report.txt"), "public");
    writeFileSync(join(stateDir, "report.txt"), PRIVATE);
    let swapped = false;
    return {
      swap() {
        if (swapped) return;
        swapped = true;
        renameSync(join(outbox, "sub"), join(outbox, "sub-old"));
        symlinkSync(stateDir, join(outbox, "sub"));
      },
      get swapped() {
        return swapped;
      }
    };
  };

  it.skipIf(!ANCHORED_OPEN_SUPPORTED)("refuses a file whose parent directory is swapped for a symlink after the path checks", () => {
    const plant = plantSwap();
    const original = fs.realpathSync;
    const spy = vi.spyOn(fs, "realpathSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const out = (original as unknown as (...a: unknown[]) => string)(p, ...rest);
      if (String(p) === join(outbox, "sub", "report.txt")) plant.swap();
      return out;
    }) as typeof fs.realpathSync);
    try {
      const msg = refused("sub/report.txt");
      expect(plant.swapped).toBe(true);
      expect(msg).not.toContain(PRIVATE);
      expect(msg).not.toContain(stateDir);
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(!ANCHORED_OPEN_SUPPORTED)("refuses a file whose parent directory is swapped for a symlink just before the open", () => {
    const plant = plantSwap();
    const original = fs.openSync;
    const spy = vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      plant.swap();
      return (original as unknown as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);
    try {
      const msg = refused("sub/report.txt");
      expect(plant.swapped).toBe(true);
      expect(msg).not.toContain(PRIVATE);
      expect(msg).not.toContain(stateDir);
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(!ANCHORED_OPEN_SUPPORTED)("refuses a symlink inside the outbox even when it points inside the outbox", () => {
    mkdirSync(join(outbox, "sub"));
    writeFileSync(join(outbox, "sub", "data.csv"), "a,b\n");
    symlinkSync(join(outbox, "report.md"), join(outbox, "alias.md"));
    symlinkSync(join(outbox, "sub"), join(outbox, "subdir"));
    expect(refused("alias.md")).toContain("symlinks are never followed");
    expect(refused("subdir/data.csv")).toContain("symlinks are never followed");
    expect(readUploadFile("sub/data.csv", cfg()).bytes.toString()).toBe("a,b\n");
  });

  it.skipIf(process.platform !== "linux")("refuses a FIFO in the outbox without blocking", () => {
    // A blocking openSync would stall this very thread, so the helper runs in
    // a child process under a deadline; the fix opens non-blocking and lets
    // fstat refuse the non-regular file.
    execFileSync("mkfifo", [join(outbox, "pipe.txt")]);
    const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const script = join(home, "fifo-probe.mts");
    writeFileSync(
      script,
      `import { readUploadFile } from ${JSON.stringify(join(pkgDir, "src", "attachments.ts"))};\n` +
        `try { readUploadFile("pipe.txt", { outboxDir: process.argv[2], stateDir: process.argv[3] }); console.log("READ"); process.exit(0); }\n` +
        `catch (e) { console.error(String((e as Error).message)); process.exit(3); }\n`
    );
    const r = spawnSync(process.execPath, ["--import", "tsx", script, outbox, stateDir], {
      cwd: pkgDir,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, HOME: home }
    });
    expect(r.signal, `helper blocked on the FIFO: ${r.stderr}`).toBeNull();
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("not a regular file");
    expect(r.stderr).toContain("pipe.txt");
    expect(r.stdout).not.toContain("READ");
  });

  // Runs on every platform, Linux included: the probe forces process.platform
  // to a value with no anchored open BEFORE the module is imported, so this
  // exercises the branch the anchored tests above have to skip. A valid,
  // regular file in the outbox must be refused there, and no pathname at all
  // may be opened: this test must fail if an open by pathname (even with leaf
  // O_NOFOLLOW) is ever used where the open cannot be anchored.
  it("refuses every attachment, without opening any path, where the open cannot be anchored", () => {
    const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const script = join(home, "platform-probe.mts");
    writeFileSync(
      script,
      `Object.defineProperty(process, "platform", { value: "darwin" });\n` +
        `const fs = (await import("node:fs")).default;\n` +
        `const mod = await import(${JSON.stringify(join(pkgDir, "src", "attachments.ts"))});\n` +
        `console.log("ANCHORED=" + mod.ANCHORED_OPEN_SUPPORTED);\n` +
        `// Record every open made from here on (the loader's own file reads are done).\n` +
        `const opened: string[] = [];\n` +
        `const realOpen = fs.openSync;\n` +
        `fs.openSync = ((p: fs.PathLike, ...rest: unknown[]) => { opened.push(String(p)); return (realOpen as unknown as (...a: unknown[]) => number)(p, ...rest); }) as typeof fs.openSync;\n` +
        `try { const r = mod.readUploadFile("report.md", { outboxDir: process.argv[2], stateDir: process.argv[3] }); console.log("READ " + r.bytes.toString()); }\n` +
        `catch (e) { console.error(String((e as Error).message)); }\n` +
        `console.log("OPENED=" + JSON.stringify(opened));\n` +
        `process.exit(opened.length === 0 ? 3 : 4);\n`
    );
    const r = spawnSync(process.execPath, ["--import", "tsx", script, outbox, stateDir], {
      cwd: pkgDir,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, HOME: home }
    });
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain("ANCHORED=false");
    expect(r.stdout, "a valid outbox file was read on a host with no anchored open").not.toContain("READ");
    expect(r.stdout).not.toContain("# report");
    expect(r.stdout, "the fallback opened a pathname").toContain("OPENED=[]");
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('attachment "report.md" refused');
    expect(r.stderr).toContain("this host (darwin) cannot anchor the open to the outbox directory");
    expect(r.stderr).toContain(outbox);
    expect(r.stderr).not.toContain("# report");
  });
});
