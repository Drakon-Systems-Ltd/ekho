import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createTestRelay, type TestRelay } from "./setup";
import { b64url, keyId, signCanonical, endorsementPayload } from "../src/operator-identity";

function makeOperatorKey(fill: number) {
  const seed = new Uint8Array(32).fill(fill);
  const pub = ed25519.getPublicKey(seed);
  return { seed, pub, pubB64: b64url(pub), id: keyId(pub) };
}

/**
 * #19 — the operator lockout.
 *
 * A device whose operator key was revoked kept signing with it. The relay
 * accepted every message, delivery reached `acked`, and each recipient
 * dead-lettered it as `unknown-operator-key`. The operator saw a green send and
 * total silence, and concluded his agents had stopped answering him.
 *
 * The documented recovery (Forget device -> Generate identity) made it worse:
 * the console can only endorse a new key with a live key held in the SAME
 * browser, so the stranded device minted an unendorsed orphan — and
 * registerOperatorKey rejects an existing key id, so that orphan could never be
 * endorsed afterwards. The key id was burnt and the operator stayed locked out.
 *
 * Two fixes, both exercised here: fail the send closed at the relay, and let a
 * device holding a live key endorse an ALREADY-REGISTERED key so a stranded
 * device can be recovered from a healthy one.
 */
describe("#19 operator signing key must be live to send", () => {
  let relay: TestRelay;
  let agentId: string;
  beforeEach(async () => {
    relay = await createTestRelay();
    agentId = (await relay.enrollAgent("Tars")).agent_id;
  });
  afterEach(() => relay.cleanup());

  const send = (signingKeyId: string) =>
    relay.db.createOperatorMessage({
      fleetId: relay.fleetId,
      operatorId: relay.operatorId,
      recipientId: agentId,
      text: "you receiving?",
      signature: { sig: "sig", keyId: signingKeyId, canonical: { t: "operator-message" } },
    });

  it("accepts a message signed by a live key", () => {
    const k = makeOperatorKey(21);
    relay.db.registerOperatorKey(relay.fleetId, k.pubB64, "laptop");
    expect(() => send(k.id)).not.toThrow();
  });

  it("REJECTS a message signed by a revoked key instead of accepting and letting every recipient bin it", () => {
    const k = makeOperatorKey(22);
    relay.db.registerOperatorKey(relay.fleetId, k.pubB64, "laptop");
    relay.db.revokeOperatorKey(relay.fleetId, k.id);
    expect(() => send(k.id)).toThrow(/revoked|not a live/i);
  });

  it("REJECTS a message signed by a key this fleet has never seen", () => {
    expect(() => send("Ry2aBChmL8E-bNl3")).toThrow(/unknown|not a live/i);
  });

  it("still accepts an unsigned message (signing stays optional)", () => {
    expect(() =>
      relay.db.createOperatorMessage({
        fleetId: relay.fleetId,
        operatorId: relay.operatorId,
        recipientId: agentId,
        text: "unsigned",
      })
    ).not.toThrow();
  });
});

describe("#19 endorsing an already-registered operator key", () => {
  let relay: TestRelay;
  beforeEach(async () => { relay = await createTestRelay(); });
  afterEach(() => relay.cleanup());

  const endorse = (root: ReturnType<typeof makeOperatorKey>, target: ReturnType<typeof makeOperatorKey>) =>
    relay.db.endorseOperatorKey(relay.fleetId, target.id, {
      endorsedByKeyId: root.id,
      signature: signCanonical(endorsementPayload(relay.fleetId, target.id, target.pubB64), root.seed),
    });

  it("endorses an orphaned key from a device holding a live key", () => {
    const root = makeOperatorKey(31);
    const orphan = makeOperatorKey(32);
    relay.db.registerOperatorKey(relay.fleetId, root.pubB64, "phone");
    relay.db.registerOperatorKey(relay.fleetId, orphan.pubB64, "laptop"); // no endorsement — the #19 orphan
    expect(
      relay.db.listOperatorKeys(relay.fleetId).find((k) => k.key_id === orphan.id)?.endorsed_by_key_id
    ).toBeNull();

    endorse(root, orphan);

    const row = relay.db.listOperatorKeys(relay.fleetId).find((k) => k.key_id === orphan.id);
    expect(row?.endorsed_by_key_id).toBe(root.id);
    expect(row?.endorsement_sig).toBeTruthy();
  });

  it("rejects an endorsement signed by a REVOKED key", () => {
    const root = makeOperatorKey(33);
    const orphan = makeOperatorKey(34);
    relay.db.registerOperatorKey(relay.fleetId, root.pubB64, "phone");
    relay.db.registerOperatorKey(relay.fleetId, orphan.pubB64, "laptop");
    relay.db.revokeOperatorKey(relay.fleetId, root.id);
    expect(() => endorse(root, orphan)).toThrow(/unknown or revoked/i);
  });

  it("rejects a forged endorsement signature", () => {
    const root = makeOperatorKey(35);
    const orphan = makeOperatorKey(36);
    relay.db.registerOperatorKey(relay.fleetId, root.pubB64, "phone");
    relay.db.registerOperatorKey(relay.fleetId, orphan.pubB64, "laptop");
    expect(() =>
      relay.db.endorseOperatorKey(relay.fleetId, orphan.id, {
        endorsedByKeyId: root.id,
        // signed by the orphan itself — exactly the self-assertion the chain exists to stop
        signature: signCanonical(endorsementPayload(relay.fleetId, orphan.id, orphan.pubB64), orphan.seed),
      })
    ).toThrow(/invalid key endorsement signature/i);
  });

  it("refuses to endorse a key that is itself revoked", () => {
    const root = makeOperatorKey(37);
    const dead = makeOperatorKey(38);
    relay.db.registerOperatorKey(relay.fleetId, root.pubB64, "phone");
    relay.db.registerOperatorKey(relay.fleetId, dead.pubB64, "laptop");
    relay.db.revokeOperatorKey(relay.fleetId, dead.id);
    expect(() => endorse(root, dead)).toThrow(/revoked/i);
  });

  it("refuses self-endorsement — a key cannot root its own trust", () => {
    const k = makeOperatorKey(39);
    relay.db.registerOperatorKey(relay.fleetId, k.pubB64, "laptop");
    expect(() => endorse(k, k)).toThrow(/itself|self/i);
  });

  it("throws for an unknown target key", () => {
    const root = makeOperatorKey(40);
    relay.db.registerOperatorKey(relay.fleetId, root.pubB64, "phone");
    const ghost = makeOperatorKey(41);
    expect(() => endorse(root, ghost)).toThrow(/not found|unknown/i);
  });

  it("does not leak across fleets", () => {
    const root = makeOperatorKey(42);
    const orphan = makeOperatorKey(43);
    relay.db.registerOperatorKey(relay.fleetId, root.pubB64, "phone");
    relay.db.registerOperatorKey(relay.fleetId, orphan.pubB64, "laptop");
    expect(() =>
      relay.db.endorseOperatorKey("flt_other_fleet", orphan.id, {
        endorsedByKeyId: root.id,
        signature: signCanonical(endorsementPayload("flt_other_fleet", orphan.id, orphan.pubB64), root.seed),
      })
    ).toThrow();
  });
});
