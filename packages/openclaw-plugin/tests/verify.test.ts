import { describe, it, expect } from "vitest";
import {
  signCanonical,
  publicKeyB64urlFromSeed,
  keyId,
  sha256Hex,
  agentKeyEndorsementPayload,
} from "../src/identity";
import { verifyInbound } from "../src/verify";

const FLEET = "flt_test";
const SELF = "agent_self";
const PEER_ID = "agent_peer";
const NOW = new Date("2026-06-07T12:00:00Z");

const OP_SEED = new Uint8Array(32).fill(1);
const OP_PUB = publicKeyB64urlFromSeed(OP_SEED);
const OP_KID = keyId(Buffer.from(OP_PUB, "base64url"));

const PEER_SEED = new Uint8Array(32).fill(2);
const PEER_PUB = publicKeyB64urlFromSeed(PEER_SEED);
const PEER_KID = keyId(Buffer.from(PEER_PUB, "base64url"));

function opMsg(opts: Partial<{ text: string; recipientId: string; nonce: string; sentAt: string }> = {}) {
  const text = opts.text ?? "do it";
  const canonical = {
    v: 1, fleet_id: FLEET, operator_id: "op", key_id: OP_KID,
    recipient: { kind: "agent", id: opts.recipientId ?? SELF },
    conversation_id: "c", body_sha256: sha256Hex(text),
    sent_at: opts.sentAt ?? "2026-06-07T12:00:00Z", nonce: opts.nonce ?? "n1",
  };
  return {
    message_id: "opm", sender_kind: "operator", sender_agent_id: "op_" + FLEET,
    body: { text }, operator_sig: signCanonical(canonical, OP_SEED), agent_sig: null,
    key_id: OP_KID, sig_canonical: canonical,
  };
}

function peerMsg(opts: Partial<{ text: string; nonce: string }> = {}) {
  const text = opts.text ?? "hi";
  const canonical = {
    v: 1, fleet_id: FLEET, sender_agent_id: PEER_ID, key_id: PEER_KID,
    recipient: { kind: "agent", id: SELF }, conversation_id: "c",
    body_sha256: sha256Hex(text), sent_at: "2026-06-07T12:00:00Z", nonce: opts.nonce ?? "p1",
  };
  return {
    message_id: "pm", sender_kind: "agent", sender_agent_id: PEER_ID,
    body: { text }, agent_sig: signCanonical(canonical, PEER_SEED), operator_sig: null,
    key_id: PEER_KID, sig_canonical: canonical,
  };
}

function roster(endorse = true, endorserSeed = OP_SEED) {
  const sig = endorse
    ? signCanonical(agentKeyEndorsementPayload(FLEET, PEER_ID, PEER_KID, PEER_PUB), endorserSeed)
    : null;
  return {
    [PEER_ID]: {
      agent_id: PEER_ID, identity_public_key: PEER_PUB, key_id: PEER_KID,
      endorsed_by_key_id: endorse ? OP_KID : null, endorsement_sig: sig,
    },
  };
}

function verify(msg: any, over: Partial<Parameters<typeof verifyInbound>[1]> = {}) {
  return verifyInbound(msg, {
    selfAgentId: SELF, fleetId: FLEET, operatorKeys: { [OP_KID]: OP_PUB },
    rosterByAgent: {}, seenNonces: new Set(), now: NOW, ...over,
  });
}

describe("verifyInbound — operator", () => {
  it("happy path", () => {
    const r = verify(opMsg());
    expect(r.verified).toBe(true);
    expect(r.kind).toBe("operator");
  });
  it("unknown operator key", () => {
    expect(verify(opMsg(), { operatorKeys: {} }).reason).toBe("unknown-operator-key");
  });
  it("recipient mismatch", () => {
    expect(verify(opMsg({ recipientId: "other" })).reason).toBe("recipient-mismatch");
  });
  it("body tamper", () => {
    const m = opMsg({ text: "do it" });
    m.body = { text: "do evil" };
    expect(verify(m).reason).toBe("body-mismatch");
  });
  it("delayed delivery within the relay TTL is valid", () => {
    // The relay holds messages up to 24h while the recipient is down; delivery
    // hours later must still verify. Regression for the 4 Aug 2026 fleet drop:
    // 300s skew silently discarded queued messages after restarts/sleep.
    expect(verify(opMsg(), { now: new Date("2026-06-07T13:00:00Z") }).verified).toBe(true); // +1h
    expect(verify(opMsg(), { now: new Date("2026-06-08T11:00:00Z") }).verified).toBe(true); // +23h
  });
  it("stale timestamp", () => {
    expect(verify(opMsg(), { now: new Date("2026-06-08T13:00:00Z") }).reason).toBe("stale"); // +25h
  });
  it("future timestamp beyond clock skew is rejected", () => {
    expect(verify(opMsg(), { now: new Date("2026-06-07T11:45:00Z") }).reason).toBe("stale"); // sent 15m ahead
  });
  it("replay", () => {
    expect(verify(opMsg({ nonce: "used" }), { seenNonces: new Set(["used"]) }).reason).toBe("replay");
  });
  it("unsigned", () => {
    const m = opMsg();
    m.operator_sig = null;
    expect(verify(m).reason).toBe("unsigned");
  });
});

describe("verifyInbound — peer", () => {
  it("happy path when endorsed", () => {
    const r = verify(peerMsg(), { rosterByAgent: roster(true) });
    expect(r.verified).toBe(true);
    expect(r.kind).toBe("peer");
  });
  it("unendorsed key rejected", () => {
    expect(verify(peerMsg(), { rosterByAgent: roster(false) }).reason).toBe("sender-key-unendorsed");
  });
  it("bad endorsement rejected", () => {
    const r = verify(peerMsg(), { rosterByAgent: roster(true, PEER_SEED) });
    expect(["bad-endorsement", "endorser-not-pinned"]).toContain(r.reason);
  });
  it("unknown sender rejected", () => {
    expect(verify(peerMsg(), { rosterByAgent: {} }).reason).toBe("unknown-sender-key");
  });
});

// #9: v2 envelopes bind message_type, priority and attachments — a relay
// relabelling a message or swapping attachments breaks the binding. v1 stays
// accepted without those checks (transition compatibility).
describe("verifyInbound — v2 bindings (#9)", () => {
  function peerV2(overrides: {
    msgType?: string; priority?: string; bodyAtt?: string[];
    canonType?: string; canonPriority?: string; canonAtt?: string[];
  } = {}) {
    const text = "hi";
    const canonical = {
      v: 2, fleet_id: FLEET, sender_agent_id: PEER_ID, key_id: PEER_KID,
      recipient: { kind: "agent", id: SELF }, conversation_id: "c",
      body_sha256: sha256Hex(text), sent_at: "2026-06-07T12:00:00Z", nonce: "v2n-" + Math.random(),
      message_type: overrides.canonType ?? "direct",
      priority: overrides.canonPriority ?? "normal",
      attachments: overrides.canonAtt ?? [],
    };
    return {
      message_id: "pm2", sender_kind: "agent", sender_agent_id: PEER_ID,
      message_type: overrides.msgType ?? "direct",
      priority: overrides.priority ?? "normal",
      body: { text, ...(overrides.bodyAtt ? { attachments: overrides.bodyAtt } : {}) },
      agent_sig: signCanonical(canonical, PEER_SEED), operator_sig: null,
      key_id: PEER_KID, sig_canonical: canonical,
    };
  }

  it("v2 happy path verifies", () => {
    const r = verify(peerV2(), { rosterByAgent: roster() });
    expect(r.verified).toBe(true);
  });
  it("relabelled message_type is rejected", () => {
    const r = verify(peerV2({ msgType: "alert" }), { rosterByAgent: roster() });
    expect(r).toMatchObject({ verified: false, reason: "type-mismatch" });
  });
  it("relabelled priority is rejected", () => {
    const r = verify(peerV2({ priority: "urgent" }), { rosterByAgent: roster() });
    expect(r).toMatchObject({ verified: false, reason: "priority-mismatch" });
  });
  it("swapped attachments are rejected", () => {
    const r = verify(peerV2({ canonAtt: ["att_1"], bodyAtt: ["att_evil"] }), { rosterByAgent: roster() });
    expect(r).toMatchObject({ verified: false, reason: "attachments-mismatch" });
  });
  it("attachment order does not matter", () => {
    const r = verify(peerV2({ canonAtt: ["att_b", "att_a"], bodyAtt: ["att_a", "att_b"] }), { rosterByAgent: roster() });
    expect(r.verified).toBe(true);
  });
  it("v1 envelopes still verify without the new bindings", () => {
    // peerMsg() is v1 and its message has no message_type/priority fields bound.
    const r = verify({ ...peerMsg(), message_type: "alert" }, { rosterByAgent: roster() });
    expect(r.verified).toBe(true);
  });
});
