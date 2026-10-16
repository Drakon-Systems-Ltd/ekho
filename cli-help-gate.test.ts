import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// #130 slice C: asking a command for help must not run it. Each entry point is
// spawned through tsx's loader with cwd, HOME, TMPDIR and every data path inside a
// throwaway directory; after `--help` / `-h` that directory must still be empty
// (no database, no .env, no state dir), the process must exit 0 on its own,
// and stdout must carry the usage text.

const root = path.resolve(__dirname);
// tsx's loader rather than its CLI: the CLI puts an IPC directory in TMPDIR,
// which would hide a real write behind a known one.
const tsxLoader = pathToFileURL(path.join(root, "node_modules", "tsx", "dist", "loader.mjs")).href;
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

// A cold tsx start is well under this; a command that boots a relay or a
// connector, or waits on a socket, is killed by it and fails the exit check.
const EXIT_DEADLINE_MS = 10_000;

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-help-gate-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

function spawn(script: string, args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ["--import", tsxLoader, path.join(root, script), ...args], {
    cwd: tmp,
    encoding: "utf8",
    timeout: EXIT_DEADLINE_MS,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: tmp,
      TMPDIR: tmp,
      TSX_DISABLE_CACHE: "1",
      EKHO_DB_PATH: path.join(tmp, "data", "ekho.sqlite"),
      EKHO_MCP_STATE_DIR: path.join(tmp, "ekho-mcp-state"),
      ...extraEnv
    }
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

// Enough for ekho-mcp's config to load, so without the gate it would go on to
// create its state dir and try to enrol (against a closed loopback port).
const MCP_ENV = {
  EKHO_RELAY_BASE_URL: "http://127.0.0.1:9",
  EKHO_FLEET_ID: "fleet_help_gate",
  EKHO_ENROLLMENT_TOKEN: "enroll_help_gate",
  EKHO_MCP_AUTH: "bearer",
  EKHO_MCP_BEARER: "b".repeat(40),
  EKHO_MCP_PORT: "0"
};

const ENTRY_POINTS = [
  { name: "setup", script: "packages/relay/src/setup.ts", usage: "Usage: tsx src/setup.ts", env: {} },
  { name: "load-test", script: "scripts/load-test.ts", usage: "Usage: npx tsx scripts/load-test.ts", env: {} },
  { name: "ekho-mcp", script: "packages/mcp-connector/src/cli.ts", usage: "Usage: ekho-mcp", env: MCP_ENV },
  { name: "recovery-grant", script: "packages/relay/src/recovery-grant.ts", usage: "Usage (on the relay host, from packages/relay):", env: {} }
] as const;

describe("--help never runs the command (#130)", () => {
  for (const entry of ENTRY_POINTS) {
    for (const flag of ["--help", "-h"]) {
      it(`${entry.name} ${flag} prints usage, exits 0 promptly and creates nothing`, () => {
        const r = spawn(entry.script, [flag], entry.env);
        expect(r.signal, `${entry.name} was killed after ${EXIT_DEADLINE_MS} ms; stderr: ${r.stderr}`).toBeNull();
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout.startsWith(entry.usage), r.stdout).toBe(true);
        expect(listFiles(tmp)).toEqual([]);
      });
    }
  }

  it("setup --doctor --help is still help, not the doctor", () => {
    const r = spawn("packages/relay/src/setup.ts", ["--doctor", "--help"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Usage: tsx src/setup.ts");
    expect(r.stdout).not.toContain("Ekho Doctor");
    expect(listFiles(tmp)).toEqual([]);
  });

  it("recovery-grant help (the word) is gated too", () => {
    const r = spawn("packages/relay/src/recovery-grant.ts", ["help"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("npm run recovery-grant -- status --fleet");
    expect(listFiles(tmp)).toEqual([]);
  });

  it("ekho-mcp --version prints the package version and nothing else happens", () => {
    const r = spawn("packages/mcp-connector/src/cli.ts", ["--version"], MCP_ENV);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(JSON.parse(read("packages/mcp-connector/package.json")).version);
    expect(listFiles(tmp)).toEqual([]);
  });

  // Controls: the throwaway env really does point the commands' data here, so
  // an empty directory after --help means the gate held, not that the command
  // wrote somewhere else.
  it("control: plain setup still creates the fleet, the database and .env in the throwaway dir", () => {
    const r = spawn("packages/relay/src/setup.ts", []);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Ekho Setup");
    const files = listFiles(tmp);
    expect(files).toContain(".env");
    expect(files).toContain(path.join("data", "ekho.sqlite"));
  });

  it("control: recovery-grant status still opens the database and reports a missing fleet", () => {
    const r = spawn("packages/relay/src/recovery-grant.ts", ["status", "--fleet", "nope"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('recovery-grant: no fleet with id or name "nope"');
    expect(listFiles(tmp)).toContain(path.join("data", "ekho.sqlite"));
  });

  it("control: ekho-mcp without configuration still refuses with a configuration error", () => {
    const r = spawn("packages/mcp-connector/src/cli.ts", []);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[ekho-mcp] configuration: EKHO_RELAY_BASE_URL is required");
  });

  it("the recovery-grant usage TTL figures match db.ts", () => {
    const db = read("packages/relay/src/db.ts");
    const usage = read("packages/relay/src/recovery-grant-usage.ts");
    const num = (src: string, name: string) => Number(src.match(new RegExp(`export const ${name} = (\\d+);`))?.[1]);
    expect(num(usage, "USAGE_DEFAULT_TTL_MINUTES")).toBe(num(db, "RECOVERY_GRANT_DEFAULT_TTL_MINUTES"));
    expect(num(usage, "USAGE_MAX_TTL_MINUTES")).toBe(num(db, "RECOVERY_GRANT_MAX_TTL_MINUTES"));
    expect(num(db, "RECOVERY_GRANT_DEFAULT_TTL_MINUTES")).toBeGreaterThan(0);
  });
});
