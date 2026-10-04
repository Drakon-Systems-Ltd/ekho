import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOrCreateIdentity,
  saveIdentity,
  storedCredentialsState,
  enrollOrLoad,
  IdentityUnavailableError,
  CredentialsUnavailableError,
  type EkhoIdentity,
} from "../src/credentials";
import { vi } from "vitest";
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

  it("preserves an unusable file byte-for-byte, including invalid UTF-8", () => {
    const d = scratch();
    const bytes = Buffer.from([0xff, 0xfe, 0x7b, 0x00, 0xc3, 0x28]); // not valid UTF-8, not JSON
    writeFileSync(join(d, FILE), bytes);
    expect(() => loadOrCreateIdentity(d)).toThrow(IdentityUnavailableError);
    const sidecars = readdirSync(d).filter((f) => f.startsWith(`${FILE}.unusable-`));
    expect(sidecars).toHaveLength(1);
    expect(Buffer.compare(readFileSync(join(d, sidecars[0])), bytes)).toBe(0);
    expect(Buffer.compare(readFileSync(join(d, FILE)), bytes)).toBe(0);
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

const CREDS = ".ekho-credentials.json";
describe("storedCredentialsState", () => {
  it("absent / ok / unusable, and unusable is NOT null-equivalent", () => {
    const d = scratch();
    expect(storedCredentialsState(d)).toEqual({ state: "absent" });
    writeFileSync(join(d, CREDS), JSON.stringify({ agentId: "agent_x", secret: "s", relayBaseUrl: "r", fleetId: "f" }));
    expect(storedCredentialsState(d)).toMatchObject({ state: "ok", credentials: { agentId: "agent_x" } });
    writeFileSync(join(d, CREDS), "{ broken");
    expect(storedCredentialsState(d).state).toBe("unusable");
    writeFileSync(join(d, CREDS), JSON.stringify({ relayBaseUrl: "r" })); // parses, no identity in it
    expect(storedCredentialsState(d).state).toBe("unusable");
  });
  it("preserves bytes only when asked", () => {
    const d = scratch();
    const bytes = Buffer.from([0xff, 0x7b, 0xfe]);
    writeFileSync(join(d, CREDS), bytes);
    storedCredentialsState(d);
    expect(readdirSync(d)).toEqual([CREDS]);
    const r = storedCredentialsState(d, { preserve: true });
    expect(r.state).toBe("unusable");
    const side = readdirSync(d).filter((f) => f.startsWith(`${CREDS}.unusable-`));
    expect(side).toHaveLength(1);
    expect(Buffer.compare(readFileSync(join(d, side[0])), bytes)).toBe(0);
  });
});

describe("enrollOrLoad never re-enrols over an unusable existing enrolment", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const tokenConfig = (configDir: string) => ({
    configDir,
    relayBaseUrl: "https://relay.invalid",
    fleetId: "flt_x",
    enrollmentToken: "tok",
    displayName: "t",
  });

  it("corrupt credentials + enrollment token → refuses, no network call, bytes kept", async () => {
    const d = scratch();
    writeFileSync(join(d, CREDS), "{ broken");
    const fetchSpy = vi.fn(async () => {
      throw new Error("must not be called");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(enrollOrLoad(tokenConfig(d))).rejects.toBeInstanceOf(CredentialsUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readFileSync(join(d, CREDS), "utf8")).toBe("{ broken");
    expect(readdirSync(d).some((f) => f.startsWith(`${CREDS}.unusable-`))).toBe(true);
  });

  it("absent credentials + enrollment token → still a genuine first enrolment", async () => {
    const d = scratch();
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ agent_id: "agent_new", secret: "sec", operator_keys: [] }),
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const creds = await enrollOrLoad(tokenConfig(d));
    expect(creds.agentId).toBe("agent_new");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(storedCredentialsState(d).state).toBe("ok");
  });

  it("the connect-site presence check treats an unusable file as enrolled", () => {
    const d = scratch();
    writeFileSync(join(d, CREDS), "{ broken");
    const hasStoredCredentials = storedCredentialsState(d).state !== "absent";
    expect(shouldAllowNewIdentity({ enrollmentToken: "tok" } as never, {}, { hasStoredCredentials })).toBe(false);
  });
});
