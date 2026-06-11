import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";
import { hashSecret, hashPassword, isScryptHash, verifyPassword } from "../src/utils";

const PASSWORD = "testpassword1"; // matches tests/setup.ts bootstrap
const HEX64 = /^[a-f0-9]{64}$/;

function creds(relay: TestRelay) {
  const op = relay.db.raw().prepare("SELECT email FROM operators WHERE id = ?").get(relay.operatorId) as { email: string };
  const fleet = relay.db.raw().prepare("SELECT name FROM fleets WHERE id = ?").get(relay.fleetId) as { name: string };
  return { email: op.email, fleetName: fleet.name };
}
const storedHash = (relay: TestRelay) =>
  (relay.db.raw().prepare("SELECT password_hash FROM operators WHERE id = ?").get(relay.operatorId) as { password_hash: string }).password_hash;
const seedLegacy = (relay: TestRelay, password: string) =>
  relay.db.raw().prepare("UPDATE operators SET password_hash = ? WHERE id = ?").run(hashSecret(password), relay.operatorId);

describe("operator password KDF (H2)", () => {
  let relay: TestRelay;
  beforeEach(async () => { relay = await createTestRelay(); });

  it("stores a new operator password as salted scrypt, not bare SHA-256", () => {
    const h = storedHash(relay);
    expect(isScryptHash(h)).toBe(true);
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(h.split("$")).toHaveLength(6);
    expect(HEX64.test(h)).toBe(false);
  });

  it("authenticates a new (scrypt) operator", () => {
    const { email, fleetName } = creds(relay);
    expect(relay.db.authenticateOperator(fleetName, email, PASSWORD)).not.toBeNull();
    expect(relay.db.authenticateOperator(fleetName, email, "wrongpassword")).toBeNull();
  });

  it("logs in a legacy SHA-256 operator AND transparently rehashes to scrypt", () => {
    const { email, fleetName } = creds(relay);
    seedLegacy(relay, PASSWORD);
    expect(HEX64.test(storedHash(relay))).toBe(true); // legacy format confirmed

    expect(relay.db.authenticateOperator(fleetName, email, PASSWORD)).not.toBeNull(); // still logs in
    expect(isScryptHash(storedHash(relay))).toBe(true); // upgraded in place
    // and the upgraded hash still authenticates
    expect(relay.db.authenticateOperator(fleetName, email, PASSWORD)).not.toBeNull();
  });

  it("does not rehash (or accept) a legacy row on a wrong password", () => {
    const { email, fleetName } = creds(relay);
    seedLegacy(relay, PASSWORD);
    const before = storedHash(relay);
    expect(relay.db.authenticateOperator(fleetName, email, "wrongpassword")).toBeNull();
    expect(storedHash(relay)).toBe(before); // untouched — no rehash on failure
    expect(HEX64.test(storedHash(relay))).toBe(true);
  });

  it("verifyPassword: handles both formats and malformed input without throwing", () => {
    const scrypt = hashPassword(PASSWORD);
    expect(verifyPassword(PASSWORD, scrypt)).toEqual({ ok: true, legacy: false });
    expect(verifyPassword("nope", scrypt)).toEqual({ ok: false, legacy: false });

    const legacy = hashSecret(PASSWORD);
    expect(verifyPassword(PASSWORD, legacy)).toEqual({ ok: true, legacy: true });
    expect(verifyPassword("nope", legacy)).toEqual({ ok: false, legacy: true });

    // malformed scrypt strings must not throw
    expect(verifyPassword(PASSWORD, "scrypt$only$three")).toEqual({ ok: false, legacy: false });
    expect(verifyPassword(PASSWORD, "scrypt$16384$8$1$!!notbase64!!$x")).toEqual({ ok: false, legacy: false });
  });

  it("leaves agent-secret / token hashing (hashSecret) untouched", async () => {
    // Enrollment + a signed agent request both rely on hashSecret; if H2 had
    // changed it, these would break.
    const a = await relay.enrollAgent("kdf-agent");
    const res = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
    expect(res.status).toBe(200);
  });
});
