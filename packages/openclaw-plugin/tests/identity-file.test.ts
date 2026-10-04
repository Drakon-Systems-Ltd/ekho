import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOrCreateIdentity,
  saveIdentity,
  IdentityUnavailableError,
  type EkhoIdentity,
} from "../src/credentials";
import { registerAndBootstrapIdentity, shouldAllowNewIdentity } from "../src/connection";

/**
 * 4 Oct 2026: seven live "Jarvis" identity keys existed on the relay with no
 * private half on the box. loadOrCreateIdentity minted a fresh seed whenever
 * the file was unparseable, or absent in whatever directory the process
 * happened to resolve, and connect() registered it. These pin the new rule:
 * mint only on a genuine first enrolment; otherwise refuse, loudly, and keep
 * the bytes.
 */
const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "ekho-idfile-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const FILE = ".ekho-identity.json";
const good: EkhoIdentity = { seedHex: "ab".repeat(32), pinnedOperatorKeys: { k: "v" } };

describe("loadOrCreateIdentity", () => {
  it("returns an existing identity untouched", () => {
    const d = scratch();
    saveIdentity(d, good);
    expect(loadOrCreateIdentity(d, { allowCreate: false })).toMatchObject(good);
  });

  it("refuses to mint over a present-but-unparseable file and keeps the bytes", () => {
    const d = scratch();
    writeFileSync(join(d, FILE), "{ not json", { mode: 0o600 });
    let err: unknown;
    try {
      loadOrCreateIdentity(d);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IdentityUnavailableError);
    expect((err as IdentityUnavailableError).reason).toBe("unreadable");
    // Original bytes intact, a preserved copy beside it, and NO new seed.
    expect(readFileSync(join(d, FILE), "utf8")).toBe("{ not json");
    const sidecars = readdirSync(d).filter((f) => f.startsWith(`${FILE}.unusable-`));
    expect(sidecars).toHaveLength(1);
    expect(readFileSync(join(d, sidecars[0]), "utf8")).toBe("{ not json");
  });

  it("refuses a file that parses but carries no seed", () => {
    const d = scratch();
    writeFileSync(join(d, FILE), JSON.stringify({ pinnedOperatorKeys: {} }));
    expect(() => loadOrCreateIdentity(d)).toThrow(IdentityUnavailableError);
    expect(JSON.parse(readFileSync(join(d, FILE), "utf8")).seedHex).toBeUndefined();
  });

  it("refuses to mint for an absent file when allowCreate is false, writing nothing", () => {
    const d = scratch();
    let err: unknown;
    try {
      loadOrCreateIdentity(d, { allowCreate: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IdentityUnavailableError);
    expect((err as IdentityUnavailableError).reason).toBe("missing");
    expect(existsSync(join(d, FILE))).toBe(false);
    expect(String(err)).toContain("EKHO_ALLOW_NEW_IDENTITY");
  });

  it("still mints on a genuine first enrolment (absent file, create allowed)", () => {
    const d = scratch();
    const id = loadOrCreateIdentity(d);
    expect(id.seedHex).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(d, FILE)).mode & 0o777).toBe(0o600);
    expect(loadOrCreateIdentity(d, { allowCreate: false }).seedHex).toBe(id.seedHex);
  });
});

describe("saveIdentity", () => {
  it("is atomic: no temp file survives and the file is always complete JSON", () => {
    const d = scratch();
    saveIdentity(d, good);
    saveIdentity(d, { ...good, pinnedOperatorKeys: { k: "v", k2: "v2" } });
    expect(readdirSync(d)).toEqual([FILE]);
    expect(JSON.parse(readFileSync(join(d, FILE), "utf8")).pinnedOperatorKeys.k2).toBe("v2");
  });
});

describe("registerAndBootstrapIdentity", () => {
  it("registers nothing with the relay when the identity is unavailable", async () => {
    const d = scratch();
    writeFileSync(join(d, FILE), "garbage");
    const calls: string[] = [];
    const client = { registerIdentityKey: async (pub: string) => void calls.push(pub) } as never;
    await expect(
      registerAndBootstrapIdentity(client, { configDir: d, allowCreate: false })
    ).rejects.toBeInstanceOf(IdentityUnavailableError);
    expect(calls).toEqual([]);
  });

  it("registers the existing key, never a new one", async () => {
    const d = scratch();
    saveIdentity(d, good);
    const calls: string[] = [];
    const client = { registerIdentityKey: async (pub: string) => void calls.push(pub) } as never;
    const id = await registerAndBootstrapIdentity(client, { configDir: d, allowCreate: false });
    expect(id.seedHex).toBe(good.seedHex);
    expect(calls).toHaveLength(1);
  });
});

describe("shouldAllowNewIdentity (the connect-site rule)", () => {
  const fresh = { hasStoredCredentials: false };
  const stored = { hasStoredCredentials: true };
  it("lets a genuine first enrolment mint", () => {
    expect(shouldAllowNewIdentity({}, {}, fresh)).toBe(true);
    expect(shouldAllowNewIdentity({ agentId: "agent_x" }, {}, fresh)).toBe(true); // no secret yet
  });
  it("refuses a config-enrolled agent by default", () => {
    expect(shouldAllowNewIdentity({ agentId: "agent_x", agentSecret: "s" }, {}, fresh)).toBe(false);
    expect(shouldAllowNewIdentity({ agentId: "agent_x", agentSecret: "s" }, { EKHO_ALLOW_NEW_IDENTITY: "0" }, fresh)).toBe(false);
  });
  it("refuses a token-enrolled agent too: its enrolment lives in the credentials file, not config", () => {
    expect(shouldAllowNewIdentity({}, {}, stored)).toBe(false);
    expect(shouldAllowNewIdentity({ enrollmentToken: "tok" } as never, {}, stored)).toBe(false);
  });
  it("allows an enrolled agent only on explicit say-so", () => {
    expect(shouldAllowNewIdentity({ agentId: "agent_x", agentSecret: "s" }, { EKHO_ALLOW_NEW_IDENTITY: "1" }, fresh)).toBe(true);
    expect(shouldAllowNewIdentity({}, { EKHO_ALLOW_NEW_IDENTITY: "1" }, stored)).toBe(true);
    expect(shouldAllowNewIdentity({ allowNewIdentity: true }, {}, stored)).toBe(true);
  });
});
