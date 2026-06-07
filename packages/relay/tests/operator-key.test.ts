// The browser operator-key module must (a) agree with the frozen vector (so the
// console signs messages the agents will verify) and (b) round-trip its passphrase
// encryption. Runs in Node (WebCrypto + @noble both work there).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  canonicalize,
  publicKeyB64url,
  keyId,
  signCanonical,
  encryptSeed,
  decryptSeed,
} from "../frontend/src/operatorKey.js";

const VECTOR = JSON.parse(
  readFileSync(new URL("./fixtures/operator-identity-vector.json", import.meta.url), "utf8")
);

const seedFromHex = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));

describe("operatorKey (frozen vector)", () => {
  it("canonical form matches", () => {
    expect(canonicalize(VECTOR.payload)).toBe(VECTOR.canonical);
  });
  it("derives the frozen public key + key_id from the seed", () => {
    const pub = publicKeyB64url(seedFromHex(VECTOR.seed_hex));
    expect(pub).toBe(VECTOR.public_key_b64url);
    expect(keyId(pub)).toBe(VECTOR.key_id);
  });
  it("reproduces the frozen signature (agents will verify console sends)", () => {
    expect(signCanonical(VECTOR.payload, seedFromHex(VECTOR.seed_hex))).toBe(VECTOR.signature_b64url);
  });
});

describe("operatorKey passphrase encryption", () => {
  it("round-trips the seed through encrypt/decrypt", async () => {
    const seed = seedFromHex(VECTOR.seed_hex);
    const blob = await encryptSeed(seed, "correct horse battery staple");
    expect(blob.ct).toBeTruthy();
    const out = await decryptSeed(blob, "correct horse battery staple");
    expect(Buffer.from(out).toString("hex")).toBe(VECTOR.seed_hex);
  });
  it("fails to decrypt with the wrong passphrase", async () => {
    const blob = await encryptSeed(seedFromHex(VECTOR.seed_hex), "right");
    await expect(decryptSeed(blob, "wrong")).rejects.toBeDefined();
  });
});
