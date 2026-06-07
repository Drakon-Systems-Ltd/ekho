// Browser operator-key crypto for the Security screen.
//
// The operator's Ed25519 private key is generated and held in the browser and
// NEVER sent to the relay — that's what stops a compromised relay forging the
// operator. Signing uses @noble (universal across mobile browsers); the seed is
// passphrase-encrypted at rest via WebCrypto (PBKDF2 -> AES-GCM).
//
// canonicalize() MUST match the relay/agents byte-for-byte; the frozen interop
// vector pins it (tests/operator-key.test.ts).

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}

export function b64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(str) {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes) {
  let h = "";
  for (let i = 0; i < bytes.length; i++) h += bytes[i].toString(16).padStart(2, "0");
  return h;
}

/** A fresh 32-byte Ed25519 seed (the operator private key). */
export function generateSeed() {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

export function publicKeyB64url(seed) {
  return b64url(ed25519.getPublicKey(seed));
}

export function keyId(publicKeyB64url) {
  return b64url(sha256(fromB64url(publicKeyB64url))).slice(0, 16);
}

export function sha256Hex(text) {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

export function signCanonical(payload, seed) {
  return b64url(ed25519.sign(new TextEncoder().encode(canonicalize(payload)), seed));
}

/** Random base64url nonce (128-bit). */
export function randomNonce() {
  const n = new Uint8Array(16);
  crypto.getRandomValues(n);
  return b64url(n);
}

/** Canonical payload for an operator->agent message (what the agent reconstructs). */
export function buildOperatorCanonical({ fleetId, operatorId, keyId: kid, recipient, conversationId, text, nonce, sentAt }) {
  return {
    v: 1,
    fleet_id: fleetId,
    operator_id: operatorId,
    key_id: kid,
    recipient,
    conversation_id: conversationId,
    body_sha256: sha256Hex(text),
    sent_at: sentAt,
    nonce,
  };
}

/** Canonical structure an operator key signs to endorse an agent's identity key. */
export function agentKeyEndorsementPayload(fleetId, agentId, agentKeyId, agentPublicKeyB64url) {
  return {
    v: 1,
    t: "agent-key-endorsement",
    fleet_id: fleetId,
    agent_id: agentId,
    key_id: agentKeyId,
    public_key: agentPublicKeyB64url,
  };
}

/** Canonical structure an existing operator key signs to endorse a new operator key. */
export function endorsementPayload(fleetId, newKeyId, newPublicKeyB64url) {
  return { v: 1, t: "op-key-endorsement", fleet_id: fleetId, key_id: newKeyId, public_key: newPublicKeyB64url };
}

// --- passphrase encryption (WebCrypto PBKDF2 -> AES-GCM) --------------------

async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptSeed(seed, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, seed));
  return { v: 1, salt: b64url(salt), iv: b64url(iv), ct: b64url(ct) };
}

export async function decryptSeed(blob, passphrase) {
  const key = await deriveKey(passphrase, fromB64url(blob.salt));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(blob.iv) }, key, fromB64url(blob.ct));
  return new Uint8Array(pt);
}
