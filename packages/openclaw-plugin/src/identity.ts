// Verifiable identity core for the OpenClaw plugin — Node built-in crypto, so no
// ESM-only dependency under NodeNext. Its canonical serialization MUST match the
// TS relay (noble) and the Python plugin (cryptography) byte-for-byte; the frozen
// interop vector (packages/relay/tests/fixtures/operator-identity-vector.json)
// pins that contract.

import crypto from "node:crypto";

/** Deterministic JSON: keys sorted, no insignificant whitespace, UTF-8. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

// Standard DER prefixes for raw 32-byte Ed25519 keys.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function privFromSeed(seed: Uint8Array): crypto.KeyObject {
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
}

function pubFromRaw(publicKey: Uint8Array): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey)]),
    format: "der",
    type: "spki",
  });
}

/** base64url(sha256(pub))[:16] — stable short id for a public key. */
export function keyId(publicKey: Uint8Array): string {
  return b64url(crypto.createHash("sha256").update(Buffer.from(publicKey)).digest()).slice(0, 16);
}

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** Raw base64url public key for a 32-byte Ed25519 seed. */
export function publicKeyB64urlFromSeed(seed: Uint8Array): string {
  const jwk = crypto.createPublicKey(privFromSeed(seed)).export({ format: "jwk" }) as { x: string };
  return jwk.x; // JWK OKP x is already base64url-encoded raw public key
}

/** Sign the canonical form of `payload` with a 32-byte Ed25519 seed. */
export function signCanonical(payload: unknown, seed: Uint8Array): string {
  const sig = crypto.sign(null, Buffer.from(canonicalize(payload), "utf8"), privFromSeed(seed));
  return Buffer.from(sig).toString("base64url");
}

/** Verify `sig` over the canonical form of `payload`. Never throws. */
export function verifyCanonical(payload: unknown, sig: string, publicKey: Uint8Array): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(canonicalize(payload), "utf8"),
      pubFromRaw(publicKey),
      Buffer.from(sig, "base64url")
    );
  } catch {
    return false;
  }
}

/** Structure an existing operator key signs to endorse a NEW operator key. */
export function endorsementPayload(fleetId: string, newKeyId: string, newPublicKeyB64url: string) {
  return {
    v: 1,
    t: "op-key-endorsement",
    fleet_id: fleetId,
    key_id: newKeyId,
    public_key: newPublicKeyB64url,
  };
}

/** Structure an operator key signs to REVOKE an operator key (#27).
 *  Revocation mutates the trust root exactly as adoption does, so it needs the
 *  same proof: an unsigned relay `revoked:true` flag is advisory only. */
export function revocationPayload(fleetId: string, revokedKeyId: string, revokedAt: string) {
  return {
    v: 1,
    t: "op-key-revocation",
    fleet_id: fleetId,
    key_id: revokedKeyId,
    revoked_at: revokedAt,
  };
}

/** Structure an operator key signs to UN-REVOKE a key (#27) — clears the
 *  tombstone so the key can be re-admitted by endorsement. Never re-pins. */
export function unrevokePayload(fleetId: string, revokedKeyId: string) {
  return {
    v: 1,
    t: "op-key-unrevoke",
    fleet_id: fleetId,
    key_id: revokedKeyId,
  };
}

/** Structure the operator signs to endorse an AGENT's identity key (peer trust). */
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
