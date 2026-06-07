import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  canonicalize,
  signCanonical,
  verifyCanonical,
  fromB64url,
  keyId,
  endorsementPayload,
  agentKeyEndorsementPayload,
} from "../src/operator-identity";

const SEED = new Uint8Array(32).fill(7); // fixed seed -> deterministic vector
const VECTOR = JSON.parse(
  readFileSync(new URL("./fixtures/operator-identity-vector.json", import.meta.url), "utf8")
);

describe("canonicalize", () => {
  it("sorts object keys and strips insignificant whitespace", () => {
    const out = canonicalize({ b: 1, a: { d: 4, c: 3 } });
    expect(out).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it("is independent of input key order", () => {
    const a = canonicalize({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalize({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
  });

  it("preserves array order and handles primitives", () => {
    expect(canonicalize({ xs: [3, 1, 2], n: null, s: "hi" })).toBe(
      '{"n":null,"s":"hi","xs":[3,1,2]}'
    );
  });
});

describe("signCanonical / verifyCanonical", () => {
  const pub = ed25519.getPublicKey(SEED);

  it("round-trips a signature over the canonical payload", () => {
    const payload = { v: 1, fleet_id: "flt_x", nonce: "AAA" };
    const sig = signCanonical(payload, SEED);
    expect(verifyCanonical(payload, sig, pub)).toBe(true);
  });

  it("verifies regardless of key order (canonical)", () => {
    const sig = signCanonical({ a: 1, b: 2 }, SEED);
    expect(verifyCanonical({ b: 2, a: 1 }, sig, pub)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const sig = signCanonical({ v: 1, fleet_id: "flt_x" }, SEED);
    expect(verifyCanonical({ v: 1, fleet_id: "flt_y" }, sig, pub)).toBe(false);
  });

  it("rejects a wrong public key", () => {
    const other = ed25519.getPublicKey(new Uint8Array(32).fill(9));
    const sig = signCanonical({ v: 1 }, SEED);
    expect(verifyCanonical({ v: 1 }, sig, other)).toBe(false);
  });

  it("returns false (not throw) on a malformed signature", () => {
    expect(verifyCanonical({ v: 1 }, "not-base64url-sig", pub)).toBe(false);
  });
});

// The cross-language contract. Any verifier (Python/Hermes, TS/OpenClaw, browser)
// MUST verify this exact vector, proving its canonicalization agrees byte-for-byte.
describe("frozen interop vector", () => {
  it("canonical form is stable", () => {
    expect(canonicalize(VECTOR.payload)).toBe(VECTOR.canonical);
  });

  it("verifies the frozen signature against the frozen public key", () => {
    const pub = fromB64url(VECTOR.public_key_b64url);
    expect(verifyCanonical(VECTOR.payload, VECTOR.signature_b64url, pub)).toBe(true);
  });

  it("the frozen signature fails if the payload is altered", () => {
    const pub = fromB64url(VECTOR.public_key_b64url);
    const tampered = { ...VECTOR.payload, conversation_id: "conv_evil" };
    expect(verifyCanonical(tampered, VECTOR.signature_b64url, pub)).toBe(false);
  });
});

describe("keyId", () => {
  it("derives base64url(sha256(pub))[:16] and matches the frozen vector", () => {
    const pub = fromB64url(VECTOR.public_key_b64url);
    expect(keyId(pub)).toBe(VECTOR.key_id);
    expect(keyId(pub)).toHaveLength(16);
  });

  it("is stable and unique per key", () => {
    const pubA = ed25519.getPublicKey(new Uint8Array(32).fill(1));
    const pubB = ed25519.getPublicKey(new Uint8Array(32).fill(2));
    expect(keyId(pubA)).toBe(keyId(pubA));
    expect(keyId(pubA)).not.toBe(keyId(pubB));
  });
});

describe("endorsementPayload", () => {
  it("binds a new key to a fleet in a stable, typed structure", () => {
    expect(canonicalize(endorsementPayload("flt_x", "kid_new", "pub_b64"))).toBe(
      canonicalize({
        v: 1,
        t: "op-key-endorsement",
        fleet_id: "flt_x",
        key_id: "kid_new",
        public_key: "pub_b64",
      })
    );
  });
});

describe("agentKeyEndorsementPayload", () => {
  it("binds an agent's identity key to its agent_id in a stable structure", () => {
    expect(
      canonicalize(agentKeyEndorsementPayload("flt_x", "agent_1", "kid", "pub_b64"))
    ).toBe(
      canonicalize({
        v: 1,
        t: "agent-key-endorsement",
        fleet_id: "flt_x",
        agent_id: "agent_1",
        key_id: "kid",
        public_key: "pub_b64",
      })
    );
  });
});
