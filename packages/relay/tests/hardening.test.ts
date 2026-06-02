import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";
import { assertOperatorSecret, isInsecureSecret } from "../src/config";
import { id, nowIso, addSeconds } from "../src/utils";

describe("Operator session secret validation", () => {
  test("throws when the secret is the insecure default", () => {
    expect(() => assertOperatorSecret("change-me", false)).toThrow();
  });

  test("throws when the secret is empty", () => {
    expect(() => assertOperatorSecret("", false)).toThrow();
  });

  test("accepts a strong secret", () => {
    expect(() => assertOperatorSecret("a-properly-random-32-char-secret-value", false)).not.toThrow();
  });

  test("allows the insecure default when explicitly opted in", () => {
    expect(() => assertOperatorSecret("change-me", true)).not.toThrow();
  });

  test("isInsecureSecret flags empty and default secrets", () => {
    expect(isInsecureSecret("")).toBe(true);
    expect(isInsecureSecret("change-me")).toBe(true);
    expect(isInsecureSecret("a-properly-random-secret-value")).toBe(false);
  });
});

describe("Replay nonce cleanup", () => {
  let relay: TestRelay;

  beforeAll(async () => {
    relay = await createTestRelay();
  });

  afterAll(() => relay.cleanup());

  test("sweepStaleNonces deletes nonces older than the skew window but keeps recent ones", async () => {
    const agent = await relay.enrollAgent("nonce-cleanup-agent");
    const agentId = agent.agent_id;
    const raw = relay.db.raw();
    const insert = raw.prepare(
      "INSERT INTO replay_nonces (id, agent_id, nonce, created_at) VALUES (?, ?, ?, ?)"
    );
    // Far older than 2x the default 300s skew window -> should be swept.
    insert.run(id("rpl"), agentId, "old-nonce", addSeconds(nowIso(), -1000));
    // Fresh -> must be retained so replay protection still holds within the window.
    insert.run(id("rpl"), agentId, "fresh-nonce", nowIso());

    const deleted = relay.db.sweepStaleNonces();
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = raw
      .prepare("SELECT nonce FROM replay_nonces WHERE agent_id = ?")
      .all(agentId) as Array<{ nonce: string }>;
    expect(remaining.map((r) => r.nonce)).toEqual(["fresh-nonce"]);
  });
});

describe("Readiness probe", () => {
  let relay: TestRelay;

  beforeAll(async () => {
    relay = await createTestRelay();
  });

  afterAll(() => relay.cleanup());

  test("/readyz returns 200 with ready:true when the database is reachable", async () => {
    const res = await relay.app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ready: true });
  });

  test("/healthz returns 200 with ok:true", async () => {
    const res = await relay.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});
