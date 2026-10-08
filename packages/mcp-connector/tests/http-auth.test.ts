import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { constantTimeEqual, StaticBearerAuthenticator, TokenBucket, bearerFromHeader } from "../src/auth";
import { startRelay, connectAgent, startServer, rpc, INITIALIZE, TEST_BEARER, type LiveRelay, type RunningServer } from "./helpers";

const relays: LiveRelay[] = [];
const servers: RunningServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const r of relays.splice(0)) await r.close();
});
async function up(env: Record<string, string> = {}) {
  const r = await startRelay();
  relays.push(r);
  const agent = await connectAgent(r);
  const s = await startServer(agent, { auth: "bearer", env });
  servers.push(s);
  return s;
}

describe("bearer auth on the MCP path", () => {
  it("401 without a token, with a WWW-Authenticate challenge and no body leak", async () => {
    const s = await up();
    const res = await rpc(s.mcpUrl, INITIALIZE);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
    expect(await res.text()).not.toContain(TEST_BEARER);
  });

  it("401 with a wrong token — including one that differs in a single trailing character", async () => {
    const s = await up();
    // (A trailing space is NOT a case: Node trims header values before we see them.)
    for (const bad of ["nope", TEST_BEARER.slice(0, -1), `${TEST_BEARER.slice(0, -1)}X`, `${TEST_BEARER}x`, TEST_BEARER.toUpperCase()]) {
      const res = await rpc(s.mcpUrl, INITIALIZE, { authorization: `Bearer ${bad}` });
      expect(res.status, `token ${JSON.stringify(bad)}`).toBe(401);
    }
    const basic = await rpc(s.mcpUrl, INITIALIZE, { authorization: `Basic ${Buffer.from(TEST_BEARER).toString("base64")}` });
    expect(basic.status).toBe(401);
  });

  it("200 with the right token (scheme case-insensitive)", async () => {
    const s = await up();
    const res = await rpc(s.mcpUrl, INITIALIZE, { authorization: `bearer ${TEST_BEARER}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("ekho-mcp");
  });

  it("the compare is constant-time over equal-length digests (length mismatch does not throw)", () => {
    expect(constantTimeEqual("a", "a")).toBe(true);
    expect(constantTimeEqual("a", "ab")).toBe(false);
    expect(constantTimeEqual("", "x".repeat(1000))).toBe(false);
    expect(bearerFromHeader("Bearer   tok ")).toBe("tok");
    expect(bearerFromHeader("Token tok")).toBeNull();
    expect(() => new StaticBearerAuthenticator("")).toThrow();
  });

  it("every presented token goes through crypto.timingSafeEqual, right or wrong (a plain === would pass every other test here)", () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    try {
      const auth = new StaticBearerAuthenticator(TEST_BEARER);
      expect(auth.authenticate(`Bearer ${TEST_BEARER}`).ok).toBe(true);
      expect(auth.authenticate(`Bearer ${TEST_BEARER}x`).ok).toBe(false);
      expect(auth.authenticate("Bearer short").ok).toBe(false);
      expect(spy).toHaveBeenCalledTimes(3);
      // No token at all is rejected before any compare: nothing to time.
      expect(auth.authenticate(undefined).ok).toBe(false);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("limits", () => {
  it("429 with Retry-After once the per-client bucket is empty", async () => {
    const s = await up({ EKHO_MCP_RATE_LIMIT_PER_MINUTE: "3" });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await fetch(`${s.baseUrl}/healthz`)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const last = await fetch(`${s.baseUrl}/healthz`);
    expect(last.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("token bucket refills continuously", () => {
    let t = 0;
    const b = new TokenBucket(60, () => t);
    for (let i = 0; i < 60; i++) expect(b.take("ip").ok).toBe(true);
    expect(b.take("ip").ok).toBe(false);
    t += 1000; // one second → one token
    expect(b.take("ip").ok).toBe(true);
    expect(b.take("ip").ok).toBe(false);
    expect(b.take("other").ok).toBe(true);
  });

  it("413 for a body over the cap, before the JSON is parsed", async () => {
    const s = await up({ EKHO_MCP_BODY_CAP_BYTES: "1024" });
    const fat = { ...INITIALIZE, params: { ...INITIALIZE.params, pad: "x".repeat(2048) } };
    const res = await rpc(s.mcpUrl, fat, { authorization: `Bearer ${TEST_BEARER}` });
    expect(res.status).toBe(413);
    // Auth still comes first: an unauthenticated fat body is a 401, not a read.
    const anon = await rpc(s.mcpUrl, fat);
    expect(anon.status).toBe(401);
  });

  it("400 on a body that is not JSON", async () => {
    const s = await up();
    const res = await rpc(s.mcpUrl, "{not json", { authorization: `Bearer ${TEST_BEARER}` });
    expect(res.status).toBe(400);
  });
});

describe("/healthz", () => {
  it("needs no auth and carries no secrets", async () => {
    const s = await up();
    const res = await fetch(`${s.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({ ok: true, agent: "connected", auth: "bearer", wake_webhook: "off" });
    expect(text).not.toContain(TEST_BEARER);
    const creds = (s.agent as unknown as { credentials: { secret: string; agentId: string } }).credentials;
    expect(text).not.toContain(creds.secret);
    expect(text).not.toContain(creds.agentId);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("unknown paths are 404 and unauthenticated", async () => {
    const s = await up();
    expect((await fetch(`${s.baseUrl}/.well-known/oauth-authorization-server`)).status).toBe(404);
    expect((await fetch(`${s.baseUrl}/oauth/token`, { method: "POST" })).status).toBe(404);
  });
});
