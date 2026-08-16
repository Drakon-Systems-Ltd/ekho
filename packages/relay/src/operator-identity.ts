// Verifiable operator identity — pure crypto core (no I/O).
//
// The operator signs each operator->agent message with a portable Ed25519 key.
// The relay stores and relays the signature verbatim; agents verify it against a
// public key they pinned at enrollment. This module is the shared reference
// implementation: its canonical serialization MUST match the Python (Hermes) and
// browser (console) verifiers byte-for-byte, so a frozen test vector pins it.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * Deterministic JSON: object keys sorted ascending, no insignificant whitespace.
 * This is the exact byte sequence that gets signed and verified everywhere.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") +
    "}"
  );
}

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/**
 * Stable short identifier for a public key: base64url(sha256(pub))[:16].
 * Used to name a registered operator key and to select it on verification.
 */
export function keyId(publicKey: Uint8Array): string {
  return b64url(sha256(publicKey)).slice(0, 16);
}

/**
 * Canonical structure an existing operator key signs to endorse a NEW key.
 * Lets already-enrolled agents (and the relay) accept an added device key only
 * if it's vouched for by a key they already trust — so a compromised relay
 * cannot inject a rogue operator key. The first key has no endorser (it's
 * trusted via enrollment pinning instead).
 */
export function endorsementPayload(fleetId: string, newKeyId: string, newPublicKeyB64url: string) {
  return {
    v: 1,
    t: "op-key-endorsement",
    fleet_id: fleetId,
    key_id: newKeyId,
    public_key: newPublicKeyB64url,
  };
}

/**
 * Canonical structure an operator key signs to REVOKE an operator key (#27).
 * Revocation mutates the trust root exactly as adoption does, so it needs the
 * same proof: agents treat an unsigned relay `revoked:true` flag as advisory
 * (skip the key for new adoption) and mutate nothing. Without this, whoever
 * controls the relay could tombstone and unpin a fleet's whole trust root in a
 * single poll. `revoked_at` is inside the signed bytes so the relay cannot
 * restate WHEN a key died under a still-valid signature.
 */
export function revocationPayload(fleetId: string, revokedKeyId: string, revokedAt: string) {
  return {
    v: 1,
    t: "op-key-revocation",
    fleet_id: fleetId,
    key_id: revokedKeyId,
    revoked_at: revokedAt,
  };
}

/**
 * Canonical structure an operator key signs to UN-REVOKE a key (#27) — the
 * escape hatch for a revocation issued in error. It clears the tombstone so the
 * key can be re-admitted through the endorsement chain; it never re-pins on its
 * own, so re-admission still costs a valid endorsement.
 */
export function unrevokePayload(fleetId: string, revokedKeyId: string) {
  return {
    v: 1,
    t: "op-key-unrevoke",
    fleet_id: fleetId,
    key_id: revokedKeyId,
  };
}

/**
 * Canonical structure the OPERATOR signs to endorse an AGENT's identity key —
 * the root of agent-to-agent trust. A peer that has pinned the operator's public
 * key can verify this endorsement and so trust the sender's key without trusting
 * the relay (a web of trust rooted at the operator).
 */
export function agentKeyEndorsementPayload(
  fleetId: string,
  agentId: string,
  agentKeyId: string,
  agentPublicKeyB64url: string
) {
  return {
    v: 1,
    t: "agent-key-endorsement",
    fleet_id: fleetId,
    agent_id: agentId,
    key_id: agentKeyId,
    public_key: agentPublicKeyB64url,
  };
}

/** Sign the canonical form of `payload` with a 32-byte Ed25519 seed. */
export function signCanonical(payload: unknown, secret: Uint8Array): string {
  return b64url(ed25519.sign(enc.encode(canonicalize(payload)), secret));
}

/** Verify `sig` over the canonical form of `payload` against a public key. */
export function verifyCanonical(
  payload: unknown,
  sig: string,
  publicKey: Uint8Array
): boolean {
  try {
    return ed25519.verify(fromB64url(sig), enc.encode(canonicalize(payload)), publicKey);
  } catch {
    return false;
  }
}
