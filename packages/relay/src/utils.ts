import crypto from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

// hashSecret is for HIGH-ENTROPY machine secrets only — agent shared secrets,
// enrollment/feed tokens. A fast deterministic hash is correct there (exact-match
// lookups depend on it, and the inputs aren't brute-forceable). Human-chosen
// OPERATOR PASSWORDS use the salted, slow KDF below instead (see hashPassword).
export function hashSecret(secret: string): string {
  return sha256(secret);
}

// --- Operator password KDF (salted, slow) ---
// Self-describing single-column encoding: `scrypt$N$r$p$<saltB64>$<hashB64>`.
// Legacy rows are bare 64-char SHA-256 hex (no `scrypt$` prefix), so old and new
// coexist in the same TEXT column and are upgraded transparently on next login.
const SCRYPT_N = 16384; // 2^14 CPU/memory cost
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;
// scrypt needs ~128*N*r bytes; pass an explicit, generous maxmem so a future
// param bump never trips Node's default ~32MB ceiling ("memory limit exceeded").
const scryptMaxmem = (n: number, r: number) => 256 * n * r;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: scryptMaxmem(SCRYPT_N, SCRYPT_R)
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function isScryptHash(stored: string): boolean {
  return typeof stored === "string" && stored.startsWith("scrypt$");
}

// Verify a password against either format, constant-time. `legacy: true` tells
// the caller this row should be rehashed-on-login. Never throws — malformed
// stored values resolve to { ok: false }.
export function verifyPassword(password: string, stored: string): { ok: boolean; legacy: boolean } {
  if (isScryptHash(stored)) {
    const parts = stored.split("$"); // ["scrypt", N, r, p, saltB64, hashB64]
    if (parts.length !== 6) return { ok: false, legacy: false };
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return { ok: false, legacy: false };
    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(parts[4], "base64");
      expected = Buffer.from(parts[5], "base64");
    } catch {
      return { ok: false, legacy: false };
    }
    if (salt.length === 0 || expected.length === 0) return { ok: false, legacy: false };
    let actual: Buffer;
    try {
      actual = crypto.scryptSync(password, salt, expected.length, { N, r, p, maxmem: scryptMaxmem(N, r) });
    } catch {
      return { ok: false, legacy: false };
    }
    if (actual.length !== expected.length) return { ok: false, legacy: false };
    return { ok: crypto.timingSafeEqual(actual, expected), legacy: false };
  }
  // Legacy unsalted SHA-256 — verify with the existing constant-time hex compare,
  // and signal the caller to rehash.
  return { ok: timingSafeEqualStr(stored, hashSecret(password)), legacy: true };
}

export function sign(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/** Constant-time string compare for secrets/HMACs/signatures — avoids leaking
 *  the expected value byte-by-byte through early-exit `!==` timing. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function addSeconds(isoDate: string, seconds: number): string {
  return new Date(new Date(isoDate).getTime() + seconds * 1000).toISOString();
}
