import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  canonicalize,
  signCanonical,
  verifyCanonical,
  keyId,
  fromB64url,
  publicKeyB64urlFromSeed,
  endorsementPayload,
  agentKeyEndorsementPayload,
  revocationPayload,
  unrevokePayload,
} from "../src/identity";

// One source of truth: the SAME frozen vector the relay produced. Passing it
// proves the OpenClaw (Node-crypto) impl agrees byte-for-byte with the TS relay
// (noble) and the Python plugin (cryptography).
const VECTOR = JSON.parse(
  readFileSync(
    new URL("../../relay/tests/fixtures/operator-identity-vector.json", import.meta.url),
    "utf8"
  )
);

describe("identity (frozen interop vector)", () => {
  it("canonical form matches the vector", () => {
    expect(canonicalize(VECTOR.payload)).toBe(VECTOR.canonical);
  });

  it("verifies the frozen signature against the frozen public key", () => {
    expect(
      verifyCanonical(VECTOR.payload, VECTOR.signature_b64url, fromB64url(VECTOR.public_key_b64url))
    ).toBe(true);
  });

  it("rejects a tampered payload", () => {
    expect(
      verifyCanonical(
        { ...VECTOR.payload, conversation_id: "conv_evil" },
        VECTOR.signature_b64url,
        fromB64url(VECTOR.public_key_b64url)
      )
    ).toBe(false);
  });

  it("returns false (not throw) on a malformed signature", () => {
    expect(verifyCanonical(VECTOR.payload, "@@bad@@", fromB64url(VECTOR.public_key_b64url))).toBe(false);
  });

  it("derives key_id and public key from the seed", () => {
    const seed = new Uint8Array(Buffer.from(VECTOR.seed_hex, "hex"));
    expect(keyId(fromB64url(VECTOR.public_key_b64url))).toBe(VECTOR.key_id);
    expect(publicKeyB64urlFromSeed(seed)).toBe(VECTOR.public_key_b64url);
  });

  it("reproduces the frozen signature when signing", () => {
    const seed = new Uint8Array(Buffer.from(VECTOR.seed_hex, "hex"));
    expect(signCanonical(VECTOR.payload, seed)).toBe(VECTOR.signature_b64url);
  });

  // #27: same bytes as the relay and the Hermes plugin, or a legitimate signed
  // revocation issued by one is unverifiable by the others.
  it("revocation / un-revoke payloads have the stable cross-language shape", () => {
    expect(canonicalize(revocationPayload("f", "k", "2026-08-16T00:00:00Z"))).toBe(
      canonicalize({
        v: 1,
        t: "op-key-revocation",
        fleet_id: "f",
        key_id: "k",
        revoked_at: "2026-08-16T00:00:00Z",
      })
    );
    expect(canonicalize(unrevokePayload("f", "k"))).toBe(
      canonicalize({ v: 1, t: "op-key-unrevoke", fleet_id: "f", key_id: "k" })
    );
  });

  it("reproduces the frozen revocation / un-revoke signatures", () => {
    const seed = new Uint8Array(Buffer.from(VECTOR.seed_hex, "hex"));
    for (const v of [VECTOR.revocation, VECTOR.unrevoke]) {
      expect(canonicalize(v.payload)).toBe(v.canonical);
      expect(signCanonical(v.payload, seed)).toBe(v.signature_b64url);
      expect(
        verifyCanonical(v.payload, v.signature_b64url, fromB64url(VECTOR.public_key_b64url))
      ).toBe(true);
    }
  });

  it("endorsement payloads have the stable cross-language shape", () => {
    expect(canonicalize(endorsementPayload("f", "k", "p"))).toBe(
      canonicalize({ v: 1, t: "op-key-endorsement", fleet_id: "f", key_id: "k", public_key: "p" })
    );
    expect(canonicalize(agentKeyEndorsementPayload("f", "a", "k", "p"))).toBe(
      canonicalize({
        v: 1,
        t: "agent-key-endorsement",
        fleet_id: "f",
        agent_id: "a",
        key_id: "k",
        public_key: "p",
      })
    );
  });
});
