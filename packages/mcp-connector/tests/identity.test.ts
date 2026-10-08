import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  IdentityUnavailableError,
  IDENTITY_FILE,
  keyId,
  fromB64url,
  publicKeyB64urlFromSeed,
  revocationPayload,
  signCanonical,
  resetAdvisoryRevocationWarningStateForTests,
  type OperatorKeyEntryLike
} from "@drakon-systems/ekho-sdk/identity";
import { EkhoConnectorAgent } from "../src/agent";
import { CREDENTIALS_FILE, CredentialsUnavailableError } from "../src/credentials";
import { startRelay, connectAgent, connectorOptions, tmpDir, makeOperatorKey, type LiveRelay } from "./helpers";

const relays: LiveRelay[] = [];
afterEach(async () => {
  resetAdvisoryRevocationWarningStateForTests();
  for (const r of relays.splice(0)) await r.close();
});
async function relay() {
  const r = await startRelay();
  relays.push(r);
  return r;
}
const readIdentity = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, IDENTITY_FILE), "utf8"));

describe("identity file rules (same as the OpenClaw plugin, #96)", () => {
  it("first start mints an identity, registers it at enrol, writes atomically and owner-only", async () => {
    const r = await relay();
    const dir = tmpDir();
    const agent = await connectAgent(r, dir);
    // Only the two trust files exist (the queue is written on first mutation);
    // no temp file left behind by the atomic writes.
    expect(fs.readdirSync(dir).sort()).toEqual([CREDENTIALS_FILE, IDENTITY_FILE].sort());
    expect(fs.statSync(path.join(dir, IDENTITY_FILE)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, CREDENTIALS_FILE)).mode & 0o777).toBe(0o600);
    const pub = agent.identityPublicKeyB64url!;
    // The relay holds the key the connector minted — registered in the enrol
    // request — which a peer sees on its roster.
    const peer = await r.enrollEndorsedPeer("peer");
    const inbox = (await peer.inbox()) as { roster: Array<{ agent_id: string; identity_public_key: string | null; key_id: string | null }> };
    const me = inbox.roster.find((x) => x.agent_id === agent.agentId)!;
    expect(me.identity_public_key).toBe(pub);
    expect(me.key_id).toBe(keyId(fromB64url(pub)));
  });

  it("refuses to start — and mints nothing — when the identity file is present but unreadable", async () => {
    const r = await relay();
    const dir = tmpDir();
    await connectAgent(r, dir);
    const before = readIdentity(dir).seedHex;
    fs.writeFileSync(path.join(dir, IDENTITY_FILE), "not json {{{");
    const again = new EkhoConnectorAgent(connectorOptions(r, dir));
    await expect(again.connect()).rejects.toBeInstanceOf(IdentityUnavailableError);
    expect(again.health().status).toBe("identity_unavailable");
    // Bytes preserved for forensics; no new seed written over them.
    const preserved = fs.readdirSync(dir).filter((f) => f.startsWith(`${IDENTITY_FILE}.unusable-`));
    expect(preserved).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, IDENTITY_FILE), "utf8")).toBe("not json {{{");
    expect(before).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to mint when the identity file is MISSING but credentials say we are enrolled", async () => {
    const r = await relay();
    const dir = tmpDir();
    await connectAgent(r, dir);
    fs.unlinkSync(path.join(dir, IDENTITY_FILE));
    const again = new EkhoConnectorAgent(connectorOptions(r, dir));
    await expect(again.connect()).rejects.toMatchObject({ name: "IdentityUnavailableError", reason: "missing" });
    expect(fs.existsSync(path.join(dir, IDENTITY_FILE))).toBe(false);
  });

  it("refuses to enrol a new agent over an unusable credentials file", async () => {
    const r = await relay();
    const dir = tmpDir();
    await connectAgent(r, dir);
    fs.writeFileSync(path.join(dir, CREDENTIALS_FILE), "\u0000garbage");
    const again = new EkhoConnectorAgent(connectorOptions(r, dir));
    await expect(again.connect()).rejects.toBeInstanceOf(CredentialsUnavailableError);
    expect(fs.readdirSync(dir).some((f) => f.startsWith(`${CREDENTIALS_FILE}.unusable-`))).toBe(true);
  });

  it("TOFU pins the relay's operator keys from the enrol response exactly once (latched)", async () => {
    const r = await relay();
    const dir = tmpDir();
    const agent = await connectAgent(r, dir);
    const id = readIdentity(dir);
    expect(Object.keys(id.pinnedOperatorKeys)).toEqual([r.root.id]);
    expect(id.tofuAt).toMatch(/^\d{4}-/);
    expect(id.operatorKeyAdmissions[r.root.id].admitted_by).toBe("tofu");
    // Empty the pin set by hand and feed an unendorsed key: the latch holds,
    // nothing is adopted, so whoever controls the relay later cannot re-seed.
    const stranger = makeOperatorKey();
    id.pinnedOperatorKeys = {};
    fs.writeFileSync(path.join(dir, IDENTITY_FILE), JSON.stringify(id));
    const reloaded = new EkhoConnectorAgent(connectorOptions(r, dir));
    await reloaded.connect();
    reloaded.ingest({ messages: [], controls: [], operator_keys: [{ key_id: stranger.id, public_key: stranger.pubB64 }] }, r.fleetId);
    expect(Object.keys(readIdentity(dir).pinnedOperatorKeys)).toEqual([]);
    void agent;
  });

  it("honours a SIGNED revocation served by the relay and tombstones the key", async () => {
    const r = await relay();
    const dir = tmpDir();
    const successor = makeOperatorKey();
    // Register an endorsed successor so the root is not the last pinned key.
    const { endorsementPayload } = await import("@drakon-systems/ekho-sdk/identity");
    await r.operatorRequest("POST", "/v1/operator/keys", {
      public_key: successor.pubB64,
      label: "successor",
      endorsement: { endorsed_by_key_id: r.root.id, signature: signCanonical(endorsementPayload(r.fleetId, successor.id, successor.pubB64), r.root.seed) }
    });
    const agent = await connectAgent(r, dir);
    expect(Object.keys(readIdentity(dir).pinnedOperatorKeys).sort()).toEqual([r.root.id, successor.id].sort());
    // The successor signs the root's revocation through the relay's real route.
    const revokedAt = new Date().toISOString();
    const rev = await r.operatorRequest("POST", `/v1/operator/keys/${r.root.id}/revoke`, {
      revoked_by_key_id: successor.id,
      revoked_at: revokedAt,
      signature: signCanonical(revocationPayload(r.fleetId, r.root.id, revokedAt), successor.seed)
    });
    expect(rev.status).toBe(200);
    await agent.pollOnce(); // the inbox batch carries operator_keys with the signed revocation
    const id = readIdentity(dir);
    expect(Object.keys(id.pinnedOperatorKeys)).toEqual([successor.id]);
    expect(id.revokedOperatorKeys[r.root.id]).toBe(revokedAt);
  });

  it("treats an UNSIGNED revoked:true as advisory: nothing unpinned, nothing tombstoned, no new adoption", async () => {
    const r = await relay();
    const dir = tmpDir();
    const agent = await connectAgent(r, dir);
    const stranger = makeOperatorKey();
    const claims: OperatorKeyEntryLike[] = [
      { key_id: r.root.id, public_key: r.root.pubB64, revoked: true },
      { key_id: stranger.id, public_key: stranger.pubB64, revoked: true, endorsed_by_key_id: r.root.id, endorsement_sig: "AAAA" }
    ];
    const warnings: string[] = [];
    const quietAgent = new EkhoConnectorAgent(connectorOptions(r, dir, { log: { warn: (...a) => warnings.push(a.join(" ")), info: () => {} } }));
    await quietAgent.connect();
    quietAgent.ingest({ messages: [], controls: [], operator_keys: claims }, r.fleetId);
    const id = readIdentity(dir);
    expect(Object.keys(id.pinnedOperatorKeys)).toEqual([r.root.id]);
    expect(id.revokedOperatorKeys ?? {}).toEqual({});
    expect(warnings.join("\n")).toMatch(/ADVISORY/);
    void agent;
  });

  it("a verifier-side mutation check fixture: the pinned key really is what verifies", () => {
    const op = makeOperatorKey();
    expect(publicKeyB64urlFromSeed(op.seed)).toBe(op.pubB64);
  });
});
