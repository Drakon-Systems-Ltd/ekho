// Operator session tokens.
//
// The original token was `operatorId.fleetId.HMAC(operatorId.fleetId)` — a
// bearer credential with no issue time and no expiry. Once minted it stayed
// valid forever, and since the console keeps it in localStorage so it survives
// reloads, a single theft (XSS, a borrowed laptop, a copied devtools value)
// granted permanent control-plane access. Nothing short of rotating the server
// secret — which invalidates every operator at once — could revoke it.
//
// Tokens now carry an issued-at inside the signed payload, so the relay can
// enforce a maximum age. The timestamp is part of the HMAC input, so it cannot
// be edited by the holder to extend their own session.
//
// Format: operatorId.fleetId.issuedAtSeconds.HMAC(operatorId.fleetId.issuedAt)
//
// Legacy 3-part tokens are rejected rather than grandfathered: they ARE the
// never-expiring credential this change exists to remove. The cost is one
// re-login per operator after upgrade.

import { sign, timingSafeEqualStr } from "./utils";

export interface SessionVerdict {
  valid: boolean;
  operatorId?: string;
  fleetId?: string;
  /** Set when invalid — a short machine-readable reason for the 401 body. */
  reason?: string;
}

/** Mint a session token for an authenticated operator. */
export function issueOperatorSession(
  secret: string,
  operatorId: string,
  fleetId: string,
  nowSeconds: number
): string {
  const issuedAt = Math.floor(nowSeconds);
  const core = `${operatorId}.${fleetId}.${issuedAt}`;
  return `${core}.${sign(secret, core)}`;
}

/**
 * Verify a token's integrity and age. Pure — no DB access, so the caller still
 * confirms the operator currently belongs to the fleet (a deleted operator's
 * cryptographically valid token must stop working).
 */
export function verifyOperatorSession(
  secret: string,
  token: string,
  nowSeconds: number,
  maxAgeSeconds: number
): SessionVerdict {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 4) {
    // A 3-part token is the legacy never-expiring format.
    return { valid: false, reason: parts.length === 3 ? "session format expired, please sign in again" : "malformed operator session" };
  }
  const [operatorId, fleetId, issuedAtRaw, signature] = parts as [string, string, string, string];
  if (!operatorId || !fleetId || !issuedAtRaw || !signature) {
    return { valid: false, reason: "malformed operator session" };
  }

  // Verify the signature BEFORE trusting any field, including the timestamp.
  const core = `${operatorId}.${fleetId}.${issuedAtRaw}`;
  if (!timingSafeEqualStr(sign(secret, core), signature)) {
    return { valid: false, reason: "invalid operator session" };
  }

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || !Number.isInteger(issuedAt)) {
    return { valid: false, reason: "malformed operator session" };
  }

  const age = nowSeconds - issuedAt;
  if (age > maxAgeSeconds) {
    return { valid: false, reason: "session expired" };
  }
  // A token stamped meaningfully in the future indicates tampering or a badly
  // skewed clock; either way don't honour it. Small skew is tolerated.
  if (age < -300) {
    return { valid: false, reason: "session not yet valid" };
  }

  return { valid: true, operatorId, fleetId };
}
