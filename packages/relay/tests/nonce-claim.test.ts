import { describe, test, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { createTestRelay, type TestRelay } from "./setup";

const sha256 = (input: string) => crypto.createHash("sha256").update(input).digest("hex");

function signedHeaders(agentId: string, secret: string, nonce: string) {
  const timestamp = new Date().toISOString();
  const payload = `GET\n/v1/inbox\n${timestamp}\n${nonce}\n${sha256("")}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return {
    "x-ekho-agent-id": agentId,
    "x-ekho-agent-secret": secret,
    "x-ekho-timestamp": timestamp,
    "x-ekho-nonce": nonce,
    "x-ekho-signature": signature
  };
}

// M2 — the replay-nonce defence must be a single ATOMIC claim (no check-then-act
// window), leaning on the existing UNIQUE(agent_id, nonce) constraint.
describe("atomic nonce claim", () => {
  let relay: TestRelay;
  let a: { agent_id: string; secret: string };
  let b: { agent_id: string; secret: string };

  beforeAll(async () => {
    relay = await createTestRelay();
    a = await relay.enrollAgent("nonce-a");
    b = await relay.enrollAgent("nonce-b");
  });
  afterAll(() => relay.cleanup());

  test("claimNonce returns true the first time and false on replay (db-level)", () => {
    expect(relay.db.claimNonce(a.agent_id, "n1")).toBe(true);
    expect(relay.db.claimNonce(a.agent_id, "n1")).toBe(false); // same pair → replay
    expect(relay.db.claimNonce(a.agent_id, "n2")).toBe(true); // different nonce → fresh
  });

  test("the same nonce string is independent per agent", () => {
    // uniqueness is scoped to (agent_id, nonce); a collision on the nonce alone
    // across two agents is NOT a replay.
    expect(relay.db.claimNonce(a.agent_id, "shared")).toBe(true);
    expect(relay.db.claimNonce(b.agent_id, "shared")).toBe(true);
    expect(relay.db.claimNonce(a.agent_id, "shared")).toBe(false);
  });

  test("a replayed signed request is rejected with 401, never a 500", async () => {
    const nonce = crypto.randomUUID();
    const headers = signedHeaders(a.agent_id, a.secret, nonce);
    const first = await relay.app.inject({ method: "GET", url: "/v1/inbox", headers });
    expect(first.statusCode).toBe(200);
    const replay = await relay.app.inject({ method: "GET", url: "/v1/inbox", headers });
    expect(replay.statusCode).toBe(401);
    expect(JSON.parse(replay.body).error).toMatch(/replayed nonce/);
    // exactly one row recorded for the pair — proof the claim, not a double-insert
    const count = relay.db.raw()
      .prepare("SELECT COUNT(*) AS c FROM replay_nonces WHERE agent_id = ? AND nonce = ?")
      .get(a.agent_id, nonce) as { c: number };
    expect(count.c).toBe(1);
  });
});
