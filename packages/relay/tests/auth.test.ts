import { describe, test, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { createTestRelay, type TestRelay } from "./setup";

const sha256 = (input: string) => crypto.createHash("sha256").update(input).digest("hex");

function signedHeaders(
  agentId: string,
  secret: string,
  opts: { timestamp?: string; nonce?: string; method?: string; urlPath?: string; body?: string } = {}
) {
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const nonce = opts.nonce ?? crypto.randomUUID();
  const method = opts.method ?? "GET";
  const urlPath = opts.urlPath ?? "/v1/inbox";
  const body = opts.body ?? "";
  const payload = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${sha256(body)}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return {
    "x-ekho-agent-id": agentId,
    "x-ekho-agent-secret": secret,
    "x-ekho-timestamp": timestamp,
    "x-ekho-nonce": nonce,
    "x-ekho-signature": signature
  };
}

describe("Agent authentication (signed requests)", () => {
  let relay: TestRelay;
  let agentId: string;
  let secret: string;

  beforeAll(async () => {
    relay = await createTestRelay();
    const agent = await relay.enrollAgent("auth-agent");
    agentId = agent.agent_id;
    secret = agent.secret;
  });

  afterAll(() => relay.cleanup());

  test("accepts a correctly signed request", async () => {
    const res = await relay.app.inject({ method: "GET", url: "/v1/inbox", headers: signedHeaders(agentId, secret) });
    expect(res.statusCode).toBe(200);
  });

  test("rejects a request missing auth headers", async () => {
    const res = await relay.app.inject({
      method: "GET",
      url: "/v1/inbox",
      headers: { "x-ekho-agent-id": agentId }
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toMatch(/missing auth headers/);
  });

  test("rejects an invalid agent secret", async () => {
    const res = await relay.app.inject({
      method: "GET",
      url: "/v1/inbox",
      headers: signedHeaders(agentId, "wrong-secret")
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toMatch(/invalid agent credentials/);
  });

  test("rejects a tampered signature", async () => {
    const headers = signedHeaders(agentId, secret);
    headers["x-ekho-signature"] = "deadbeef".repeat(8);
    const res = await relay.app.inject({ method: "GET", url: "/v1/inbox", headers });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toMatch(/invalid signature/);
  });

  test("rejects a timestamp outside the allowed skew", async () => {
    const stale = new Date(Date.now() - 1000 * 1000).toISOString();
    const res = await relay.app.inject({
      method: "GET",
      url: "/v1/inbox",
      headers: signedHeaders(agentId, secret, { timestamp: stale })
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toMatch(/timestamp outside allowed skew/);
  });

  test("rejects a replayed nonce", async () => {
    const nonce = crypto.randomUUID();
    const headers = signedHeaders(agentId, secret, { nonce });
    const first = await relay.app.inject({ method: "GET", url: "/v1/inbox", headers });
    expect(first.statusCode).toBe(200);

    const replay = await relay.app.inject({ method: "GET", url: "/v1/inbox", headers });
    expect(replay.statusCode).toBe(401);
    expect(JSON.parse(replay.body).error).toMatch(/replayed nonce/);
  });
});
