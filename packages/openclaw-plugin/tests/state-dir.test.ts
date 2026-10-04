import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCredentials,
  loadOrCreateIdentity,
  identityPublicKey,
  saveCredentials,
  saveIdentity,
  IdentityUnavailableError,
  CredentialsUnavailableError,
  type EkhoCredentials,
  type EkhoIdentity,
} from "../src/credentials";
import { fromB64url, keyId } from "../src/identity";
import { LEGACY_EKHO_DIR, migrateLegacyEkhoState, resolveEkhoStateDir } from "../src/state-dir";

/**
 * ekho#98: state used to live in the plugin's install dir, which
 * `openclaw plugins update` replaces wholesale. These pin the move to the state
 * dir and the one-time copy of pre-#98 files out of the old location. Every
 * path here is a scratch dir; the real ~/.openclaw is never touched.
 */
const dirs: string[] = [];
const scratch = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `ekho-statedir-${tag}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const CREDS = ".ekho-credentials.json";
const IDENT = ".ekho-identity.json";
const creds: EkhoCredentials = {
  agentId: "agent-test-1",
  secret: "not-a-real-secret",
  relayBaseUrl: "https://relay.example.test",
  fleetId: "fleet-test",
};
const ident: EkhoIdentity = { seedHex: "ab".repeat(32), pinnedOperatorKeys: { "op-test": "pub-test" } };
const keyIdOf = (id: EkhoIdentity) => keyId(fromB64url(identityPublicKey(id)));
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** Legacy dir + a not-yet-created new dir inside a scratch parent. */
const setup = () => ({ legacy: scratch("legacy"), fresh: join(scratch("state"), "ekho-adapter") });
const seedLegacy = (legacy: string) => {
  saveCredentials(legacy, creds);
  saveIdentity(legacy, ident);
};

describe("resolveEkhoStateDir", () => {
  it("config.stateDir beats EKHO_STATE_DIR beats the OpenClaw state dir", () => {
    const fromCfg = scratch("cfg");
    const fromEnv = scratch("env");
    const ocState = scratch("oc");
    vi.stubEnv("OPENCLAW_STATE_DIR", ocState);
    vi.stubEnv("EKHO_STATE_DIR", fromEnv);
    expect(resolveEkhoStateDir({ stateDir: fromCfg })).toBe(fromCfg);
    expect(resolveEkhoStateDir({ stateDir: "  " })).toBe(fromEnv);
    expect(resolveEkhoStateDir()).toBe(fromEnv);
    vi.stubEnv("EKHO_STATE_DIR", "");
    expect(resolveEkhoStateDir()).toBe(join(ocState, "ekho-adapter"));
  });

  it("the default is never the install dir", () => {
    vi.stubEnv("EKHO_STATE_DIR", "");
    expect(resolveEkhoStateDir()).not.toBe(LEGACY_EKHO_DIR);
    expect(resolveEkhoStateDir()).not.toContain(join(".openclaw", "extensions"));
  });
});

describe("migrateLegacyEkhoState", () => {
  it("fresh install: nothing to migrate, nothing created, nothing thrown", () => {
    const { legacy, fresh } = setup();
    const log = logger();
    expect(() => migrateLegacyEkhoState(fresh, legacy, log)).not.toThrow();
    expect(existsSync(fresh)).toBe(false);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("legacy-only: copies both files byte-for-byte at 0600 and leaves the originals", () => {
    const { legacy, fresh } = setup();
    seedLegacy(legacy);
    const before = { c: readFileSync(join(legacy, CREDS)), i: readFileSync(join(legacy, IDENT)) };
    const log = logger();

    migrateLegacyEkhoState(fresh, legacy, log);

    expect(readFileSync(join(fresh, CREDS)).equals(before.c)).toBe(true);
    expect(readFileSync(join(fresh, IDENT)).equals(before.i)).toBe(true);
    expect(loadCredentials(fresh)).toEqual(creds);
    const migrated = loadOrCreateIdentity(fresh, { allowCreate: false });
    expect(migrated).toMatchObject(ident);
    expect(keyIdOf(migrated)).toBe(keyIdOf(ident));
    // Copy, not move.
    expect(readFileSync(join(legacy, CREDS)).equals(before.c)).toBe(true);
    expect(readFileSync(join(legacy, IDENT)).equals(before.i)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(join(fresh, CREDS)).mode & 0o777).toBe(0o600);
      expect(statSync(join(fresh, IDENT)).mode & 0o777).toBe(0o600);
    }
    expect(log.info).toHaveBeenCalledTimes(2);
    // No temp files left behind.
    expect(readdirSync(fresh).sort()).toEqual([CREDS, IDENT].sort());
  });

  it("both present: the new dir wins untouched and the stale legacy copy is reported", () => {
    const { legacy, fresh } = setup();
    seedLegacy(legacy);
    const newer: EkhoIdentity = { seedHex: "cd".repeat(32), pinnedOperatorKeys: {} };
    saveIdentity(fresh, newer);
    saveCredentials(fresh, { ...creds, agentId: "agent-test-2" });
    const before = { c: readFileSync(join(fresh, CREDS)), i: readFileSync(join(fresh, IDENT)) };
    const log = logger();

    migrateLegacyEkhoState(fresh, legacy, log);

    expect(readFileSync(join(fresh, IDENT)).equals(before.i)).toBe(true);
    expect(readFileSync(join(fresh, CREDS)).equals(before.c)).toBe(true);
    expect(keyIdOf(loadOrCreateIdentity(fresh, { allowCreate: false }))).toBe(keyIdOf(newer));
    expect(keyIdOf(newer)).not.toBe(keyIdOf(ident));
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    const warned = log.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain(legacy);
    expect(warned).toContain("no longer used");
  });

  it("corrupt legacy identity with no new copy: fails closed, mints nothing", () => {
    const { legacy, fresh } = setup();
    saveCredentials(legacy, creds);
    writeFileSync(join(legacy, IDENT), "{ not json", { mode: 0o600 });

    let err: unknown;
    try {
      migrateLegacyEkhoState(fresh, legacy, logger());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IdentityUnavailableError);
    expect((err as IdentityUnavailableError).reason).toBe("unreadable");
    expect(String(err)).toContain(join(legacy, IDENT));
    expect(existsSync(join(fresh, IDENT))).toBe(false);
    // The good file still came across; the bad one is left exactly as it was.
    expect(loadCredentials(fresh)).toEqual(creds);
    expect(readFileSync(join(legacy, IDENT), "utf8")).toBe("{ not json");
    // And the loader, pointed at the new dir, refuses rather than minting.
    expect(() => loadOrCreateIdentity(fresh, { allowCreate: false })).toThrow(IdentityUnavailableError);
  });

  it("legacy identity without a seed counts as unusable too", () => {
    const { legacy, fresh } = setup();
    writeFileSync(join(legacy, IDENT), JSON.stringify({ pinnedOperatorKeys: {} }), { mode: 0o600 });
    expect(() => migrateLegacyEkhoState(fresh, legacy)).toThrow(IdentityUnavailableError);
    expect(existsSync(join(fresh, IDENT))).toBe(false);
  });

  it("legacy credentials missing required fields with no new copy: CredentialsUnavailableError", () => {
    const { legacy, fresh } = setup();
    writeFileSync(join(legacy, CREDS), JSON.stringify({ agentId: "agent-test-1" }), { mode: 0o600 });
    expect(() => migrateLegacyEkhoState(fresh, legacy)).toThrow(CredentialsUnavailableError);
    expect(existsSync(join(fresh, CREDS))).toBe(false);
  });

  it("survives a plugin update: install dir wiped after migration, state intact", () => {
    const { legacy, fresh } = setup();
    seedLegacy(legacy);
    const snapshot = { c: readFileSync(join(legacy, CREDS)), i: readFileSync(join(legacy, IDENT)) };

    migrateLegacyEkhoState(fresh, legacy, logger());
    // `openclaw plugins update` replaces the install dir wholesale.
    rmSync(legacy, { recursive: true, force: true });
    expect(existsSync(legacy)).toBe(false);
    // The next startup runs the migration again; with nothing to copy, it must be a no-op.
    migrateLegacyEkhoState(fresh, legacy, logger());

    expect(readFileSync(join(fresh, CREDS)).equals(snapshot.c)).toBe(true);
    expect(readFileSync(join(fresh, IDENT)).equals(snapshot.i)).toBe(true);
    expect(loadCredentials(fresh)).toEqual(creds);
    const loaded = loadOrCreateIdentity(fresh, { allowCreate: false });
    expect(loaded.seedHex).toBe(ident.seedHex);
    expect(keyIdOf(loaded)).toBe(keyIdOf(ident));
  });

  it("is idempotent: a second call neither throws, re-copies nor repeats itself", () => {
    const { legacy, fresh } = setup();
    seedLegacy(legacy);
    const log = logger();
    migrateLegacyEkhoState(fresh, legacy, log);
    const after = { c: readFileSync(join(fresh, CREDS)), i: readFileSync(join(fresh, IDENT)) };
    const mtimes = [statSync(join(fresh, CREDS)).mtimeMs, statSync(join(fresh, IDENT)).mtimeMs];

    expect(() => migrateLegacyEkhoState(fresh, legacy, log)).not.toThrow();
    migrateLegacyEkhoState(fresh, legacy, log);

    expect(readFileSync(join(fresh, CREDS)).equals(after.c)).toBe(true);
    expect(readFileSync(join(fresh, IDENT)).equals(after.i)).toBe(true);
    expect([statSync(join(fresh, CREDS)).mtimeMs, statSync(join(fresh, IDENT)).mtimeMs]).toEqual(mtimes);
    expect(readdirSync(fresh).sort()).toEqual([CREDS, IDENT].sort());
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("is a no-op when the state dir is pointed at the legacy dir", () => {
    const { legacy } = setup();
    seedLegacy(legacy);
    const log = logger();
    migrateLegacyEkhoState(legacy, legacy, log);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(readdirSync(legacy).sort()).toEqual([CREDS, IDENT].sort());
  });
});

describe("saveCredentials", () => {
  it("writes owner-only, atomically", () => {
    const d = scratch("creds");
    saveCredentials(d, creds);
    if (process.platform !== "win32") {
      expect(statSync(join(d, CREDS)).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(d)).toEqual([CREDS]);
    expect(loadCredentials(d)).toEqual(creds);
  });
});

describe("ensureConnected wiring", () => {
  it("migrates into the state dir before loading, and a corrupt legacy identity runs unsigned instead of minting", async () => {
    const home = scratch("home");
    const legacy = join(home, ".openclaw", "extensions", "ekho-adapter");
    const fresh = join(scratch("state"), "ekho-adapter");
    saveCredentials(legacy, creds);
    writeFileSync(join(legacy, IDENT), "{ not json", { mode: 0o600 });
    // LEGACY_EKHO_DIR is fixed at import, so load a fresh module graph under the scratch home.
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const conn = await import("../src/connection");
    const log = logger();
    try {
      // Unroutable relay: connecting needs no network, the heartbeat just fails quietly.
      await conn.ensureConnected({ relayBaseUrl: "http://127.0.0.1:9", stateDir: fresh }, log);
      expect(loadCredentials(fresh)).toEqual(creds);
      expect(existsSync(join(fresh, IDENT))).toBe(false);
      expect(conn.getEkhoIdentity()).toBeNull();
      const errors = log.error.mock.calls.map((c) => String(c[0])).join("\n");
      expect(errors).toContain("running UNSIGNED");
      expect(errors).toContain(join(legacy, IDENT));
    } finally {
      conn.shutdown();
    }
  });
});
