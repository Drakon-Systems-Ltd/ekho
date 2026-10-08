import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import {
  canonicalize,
  signCanonical,
  verifyCanonical,
  keyId,
  fromB64url,
  publicKeyB64urlFromSeed,
  buildSignedSendFields,
  verifyInbound,
  agentKeyEndorsementPayload
} from "../src/identity/index";

// The SAME frozen vector the relay produced and the OpenClaw plugin's own
// identity.test.ts checks. Pinned here too: this module is now the single
// implementation both the plugin and the MCP connector sign with, so the
// contract has to hold at the source, not only through a re-export.
const VECTOR = JSON.parse(
  readFileSync(new URL("../../relay/tests/fixtures/operator-identity-vector.json", import.meta.url), "utf8")
);

describe("@drakon-systems/ekho-sdk/identity (frozen interop vector)", () => {
  it("canonical form, signature and key id match the vector", () => {
    const seed = new Uint8Array(Buffer.from(VECTOR.seed_hex, "hex"));
    expect(canonicalize(VECTOR.payload)).toBe(VECTOR.canonical);
    expect(signCanonical(VECTOR.payload, seed)).toBe(VECTOR.signature_b64url);
    expect(verifyCanonical(VECTOR.payload, VECTOR.signature_b64url, fromB64url(VECTOR.public_key_b64url))).toBe(true);
    expect(keyId(fromB64url(VECTOR.public_key_b64url))).toBe(VECTOR.key_id);
    expect(publicKeyB64urlFromSeed(seed)).toBe(VECTOR.public_key_b64url);
  });

  it("rejects a tampered payload and never throws on garbage", () => {
    const pub = fromB64url(VECTOR.public_key_b64url);
    expect(verifyCanonical({ ...VECTOR.payload, conversation_id: "conv_evil" }, VECTOR.signature_b64url, pub)).toBe(false);
    expect(verifyCanonical(VECTOR.payload, "@@bad@@", pub)).toBe(false);
  });
});

describe("buildSignedSendFields → verifyInbound (v2 envelope)", () => {
  const OP_SEED = new Uint8Array(32).fill(1);
  const OP_PUB = publicKeyB64urlFromSeed(OP_SEED);
  const OP_KID = keyId(fromB64url(OP_PUB));
  const AGENT_SEED_HEX = "02".repeat(32);
  const AGENT_PUB = publicKeyB64urlFromSeed(new Uint8Array(Buffer.from(AGENT_SEED_HEX, "hex")));
  const AGENT_KID = keyId(fromB64url(AGENT_PUB));
  const FLEET = "flt_sdk";

  it("a recipient with the operator key pinned and the sender endorsed verifies it", () => {
    const fields = buildSignedSendFields({
      identity: { seedHex: AGENT_SEED_HEX, pinnedOperatorKeys: {} },
      fleetId: FLEET,
      selfAgentId: "agent_a",
      recipient: { kind: "agent", id: "agent_b" },
      conversationId: "conv-1",
      bodyText: "hello",
      nonce: "n-1",
      sentAt: new Date().toISOString(),
      messageType: "direct",
      priority: "normal",
      attachments: []
    });
    expect(fields.key_id).toBe(AGENT_KID);
    const endorsement = signCanonical(agentKeyEndorsementPayload(FLEET, "agent_a", AGENT_KID, AGENT_PUB), OP_SEED);
    const verdict = verifyInbound(
      {
        message_id: "m1",
        sender_kind: "agent",
        sender_agent_id: "agent_a",
        message_type: "direct",
        priority: "normal",
        body: { text: "hello", attachments: [] },
        agent_sig: fields.agent_sig,
        key_id: fields.key_id,
        sig_canonical: fields.sig_canonical
      },
      {
        selfAgentId: "agent_b",
        fleetId: FLEET,
        operatorKeys: { [OP_KID]: OP_PUB },
        rosterByAgent: {
          agent_a: { agent_id: "agent_a", identity_public_key: AGENT_PUB, key_id: AGENT_KID, endorsed_by_key_id: OP_KID, endorsement_sig: endorsement }
        },
        seenNonces: new Set(),
        now: new Date()
      }
    );
    expect(verdict).toEqual({ verified: true, kind: "peer", reason: null, keyId: AGENT_KID });
  });

  it("random nonces never collide in the canonical", () => {
    const a = crypto.randomBytes(16).toString("base64url");
    const b = crypto.randomBytes(16).toString("base64url");
    expect(a).not.toBe(b);
  });
});
