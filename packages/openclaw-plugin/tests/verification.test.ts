import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  signCanonical,
  publicKeyB64urlFromSeed,
  keyId,
  endorsementPayload,
} from "../src/identity";
import {
  loadOrCreateIdentity,
  identityPublicKey,
  type EkhoIdentity,
} from "../src/credentials";
import {
  syncPinnedOperatorKeys,
  shouldAutowake,
  buildSignedSendFields,
} from "../src/verification";
import { verifyCanonical, fromB64url } from "../src/identity";

const OP1_SEED = new Uint8Array(32).fill(1);
const OP1_PUB = publicKeyB64urlFromSeed(OP1_SEED);
const OP1_KID = keyId(fromB64url(OP1_PUB));
const OP2_SEED = new Uint8Array(32).fill(2);
const OP2_PUB = publicKeyB64urlFromSeed(OP2_SEED);
const OP2_KID = keyId(fromB64url(OP2_PUB));
const FLEET = "flt_v";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ekho-oc-"));
}

describe("identity store", () => {
  it("creates and persists a stable identity", () => {
    const dir = tmpdir();
    const a = loadOrCreateIdentity(dir);
    expect(Buffer.from(a.seedHex, "hex").length).toBe(32);
    const b = loadOrCreateIdentity(dir);
    expect(b.seedHex).toBe(a.seedHex);
    expect(identityPublicKey(a)).toBe(identityPublicKey(b));
  });
});

describe("syncPinnedOperatorKeys", () => {
  // #5: a never-pinned identity TOFUs the relay's key set exactly once —
  // "never adopt" left verification dormant on every unconfigured agent.
  it("TOFU-adopts the first key set for a never-pinned identity, and latches", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: {} };
    expect(syncPinnedOperatorKeys(id, [{ key_id: OP1_KID, public_key: OP1_PUB }], FLEET)).toBe(true);
    expect(id.pinnedOperatorKeys[OP1_KID]).toBe(OP1_PUB);
    expect(id.tofuAt).toBeTruthy();

    // Once latched, an emptied pin set can never be re-seeded by the relay.
    id.pinnedOperatorKeys = {};
    expect(syncPinnedOperatorKeys(id, [{ key_id: OP2_KID, public_key: OP2_PUB }], FLEET)).toBe(false);
    expect(id.pinnedOperatorKeys).toEqual({});
  });
  it("TOFU skips revoked keys and doesn't burn the latch on an empty roster", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: {} };
    expect(syncPinnedOperatorKeys(id, [], FLEET)).toBe(false);
    expect(id.tofuAt).toBeUndefined(); // nothing adopted — next contact may still TOFU
    expect(syncPinnedOperatorKeys(id, [{ key_id: OP1_KID, public_key: OP1_PUB, revoked: true }], FLEET)).toBe(false);
    expect(id.tofuAt).toBeUndefined();
  });
  it("a pre-pinned identity never TOFUs — unendorsed keys are still refused", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: { [OP1_KID]: OP1_PUB } };
    expect(syncPinnedOperatorKeys(id, [{ key_id: OP2_KID, public_key: OP2_PUB }], FLEET)).toBe(false);
    expect(id.pinnedOperatorKeys[OP2_KID]).toBeUndefined();
  });
  it("adds an endorsement-chained key", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: { [OP1_KID]: OP1_PUB } };
    const esig = signCanonical(endorsementPayload(FLEET, OP2_KID, OP2_PUB), OP1_SEED);
    const changed = syncPinnedOperatorKeys(
      id,
      [{ key_id: OP2_KID, public_key: OP2_PUB, endorsed_by_key_id: OP1_KID, endorsement_sig: esig }],
      FLEET
    );
    expect(changed).toBe(true);
    expect(id.pinnedOperatorKeys[OP2_KID]).toBe(OP2_PUB);
  });
  it("drops a revoked key", () => {
    const id: EkhoIdentity = { seedHex: "00".repeat(32), pinnedOperatorKeys: { [OP1_KID]: OP1_PUB } };
    expect(syncPinnedOperatorKeys(id, [{ key_id: OP1_KID, public_key: OP1_PUB, revoked: true }], FLEET)).toBe(true);
    expect(id.pinnedOperatorKeys[OP1_KID]).toBeUndefined();
  });
});

describe("shouldAutowake (graceful gate)", () => {
  const op = (verified?: boolean, signed = true) => ({
    sender_kind: "operator",
    operator_sig: signed ? "S" : null,
    agent_sig: null,
  });
  it("verified operator acts even with relay flag false", () => {
    expect(shouldAutowake(op(true) as any, { verified: true } as any, false, false)).toBe(true);
  });
  it("signed-invalid operator blocked even with relay flag true", () => {
    expect(shouldAutowake(op(false) as any, { verified: false } as any, true, false)).toBe(false);
  });
  it("unsigned operator falls back to relay trust", () => {
    expect(shouldAutowake(op(undefined, false) as any, null, true, false)).toBe(true);
    expect(shouldAutowake(op(undefined, false) as any, null, false, false)).toBe(false);
  });

  // #5: "require" closes the fail-open peer paths.
  const peer = (signed: boolean) => ({ sender_kind: "agent", agent_sig: signed ? "S" : null, operator_sig: null });
  it("require mode: unsigned peer does NOT wake (was the fail-open default)", () => {
    expect(shouldAutowake(peer(false) as any, null, false, true)).toBe(true); // warn: legacy fail-open
    expect(shouldAutowake(peer(false) as any, null, false, true, "require")).toBe(false);
  });
  it("require mode: signed-but-unverifiable (no pinned keys) does NOT wake", () => {
    expect(shouldAutowake(peer(true) as any, null, false, true)).toBe(true); // warn: dormant crypto waves it through
    expect(shouldAutowake(peer(true) as any, null, false, true, "require")).toBe(false);
  });
  it("require mode: signed and verified peer wakes", () => {
    expect(shouldAutowake(peer(true) as any, { verified: true } as any, false, true, "require")).toBe(true);
  });
  it("require mode: operator relay-trust fallback is preserved", () => {
    expect(shouldAutowake(op(undefined, false) as any, null, true, false, "require")).toBe(true);
  });
});

describe("buildSignedSendFields", () => {
  it("round-trips: a recipient can verify it", () => {
    const id: EkhoIdentity = { seedHex: "0a".repeat(32), pinnedOperatorKeys: {} };
    const fields = buildSignedSendFields({
      identity: id, fleetId: "flt", selfAgentId: "me",
      recipient: { kind: "agent", id: "peer" }, conversationId: "c",
      bodyText: "hello", nonce: "n1", sentAt: "2026-06-07T00:00:00Z",
      messageType: "direct", priority: "normal",
    });
    expect(verifyCanonical(fields.sig_canonical, fields.agent_sig, fromB64url(identityPublicKey(id)))).toBe(true);
    expect(fields.sig_canonical.sender_agent_id).toBe("me");
  });
  it("v2 envelope (#9) binds type, priority and sorted attachment ids", () => {
    const id: EkhoIdentity = { seedHex: "0a".repeat(32), pinnedOperatorKeys: {} };
    const fields = buildSignedSendFields({
      identity: id, fleetId: "flt", selfAgentId: "me",
      recipient: { kind: "agent", id: "peer" }, conversationId: "c",
      bodyText: "hello", nonce: "n2", sentAt: "2026-06-07T00:00:00Z",
      messageType: "direct", priority: "high", attachments: ["att_b", "att_a"],
    });
    expect(fields.sig_canonical.v).toBe(2);
    expect(fields.sig_canonical.message_type).toBe("direct");
    expect(fields.sig_canonical.priority).toBe("high");
    expect(fields.sig_canonical.attachments).toEqual(["att_a", "att_b"]);
  });
});
