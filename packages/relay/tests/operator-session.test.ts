import { describe, it, expect } from "vitest";
import { issueOperatorSession, verifyOperatorSession } from "../src/operator-session";
import { sign } from "../src/utils";

const SECRET = "a".repeat(64);
const NOW = 1_800_000_000;
const MAX_AGE = 86_400; // 24h

describe("operator session tokens", () => {
  it("round-trips a freshly issued token", () => {
    const token = issueOperatorSession(SECRET, "op_1", "flt_1", NOW);
    const verdict = verifyOperatorSession(SECRET, token, NOW, MAX_AGE);
    expect(verdict.valid).toBe(true);
    expect(verdict.operatorId).toBe("op_1");
    expect(verdict.fleetId).toBe("flt_1");
  });

  it("accepts a token within its lifetime and rejects it after", () => {
    const token = issueOperatorSession(SECRET, "op_1", "flt_1", NOW);
    expect(verifyOperatorSession(SECRET, token, NOW + MAX_AGE - 1, MAX_AGE).valid).toBe(true);
    const expired = verifyOperatorSession(SECRET, token, NOW + MAX_AGE + 1, MAX_AGE);
    expect(expired.valid).toBe(false);
    expect(expired.reason).toBe("session expired");
  });

  it("rejects the legacy never-expiring 3-part token", () => {
    const core = "op_1.flt_1";
    const legacy = `${core}.${sign(SECRET, core)}`;
    const verdict = verifyOperatorSession(SECRET, legacy, NOW, MAX_AGE);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("sign in again");
  });

  it("refuses a token whose timestamp was edited to extend the session", () => {
    const token = issueOperatorSession(SECRET, "op_1", "flt_1", NOW - MAX_AGE - 5000);
    const [operatorId, fleetId, , signature] = token.split(".");
    // Attacker rewrites issued-at to "now" but cannot re-sign it.
    const forged = `${operatorId}.${fleetId}.${NOW}.${signature}`;
    const verdict = verifyOperatorSession(SECRET, forged, NOW, MAX_AGE);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("invalid operator session");
  });

  it("refuses a token signed with a different secret", () => {
    const token = issueOperatorSession("b".repeat(64), "op_1", "flt_1", NOW);
    expect(verifyOperatorSession(SECRET, token, NOW, MAX_AGE).valid).toBe(false);
  });

  it("refuses a token that swaps in another operator or fleet", () => {
    const token = issueOperatorSession(SECRET, "op_1", "flt_1", NOW);
    const [, , issuedAt, signature] = token.split(".");
    expect(verifyOperatorSession(SECRET, `op_evil.flt_1.${issuedAt}.${signature}`, NOW, MAX_AGE).valid).toBe(false);
    expect(verifyOperatorSession(SECRET, `op_1.flt_evil.${issuedAt}.${signature}`, NOW, MAX_AGE).valid).toBe(false);
  });

  it("rejects malformed and empty tokens without throwing", () => {
    for (const bad of ["", "...", "a.b", "a.b.c.d.e", "nonsense"]) {
      expect(verifyOperatorSession(SECRET, bad, NOW, MAX_AGE).valid).toBe(false);
    }
  });

  it("tolerates small clock skew but rejects a far-future stamp", () => {
    const slightlyAhead = issueOperatorSession(SECRET, "op_1", "flt_1", NOW + 60);
    expect(verifyOperatorSession(SECRET, slightlyAhead, NOW, MAX_AGE).valid).toBe(true);
    const farFuture = issueOperatorSession(SECRET, "op_1", "flt_1", NOW + 99_999);
    const verdict = verifyOperatorSession(SECRET, farFuture, NOW, MAX_AGE);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe("session not yet valid");
  });
});
