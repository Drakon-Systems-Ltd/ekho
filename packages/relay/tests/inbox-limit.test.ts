import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// #35 — GET /v1/inbox is the 5-second fleet poll. The other agent list
// endpoints already go through clampLimit; inbox still fed Number() straight
// into SQLite LIMIT. Fractional → SQLITE_MISMATCH 500. Negative → no limit.
describe("GET /v1/inbox limit clamp (#35)", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });

  async function seedInbox(count: number) {
    const sender = await relay.enrollAgent(`inbox-limit-src-${count}-${Math.random().toString(16).slice(2)}`);
    const receiver = await relay.enrollAgent(`inbox-limit-dst-${count}-${Math.random().toString(16).slice(2)}`);
    for (let i = 0; i < count; i++) {
      const res = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: receiver.agent_id },
        message_type: "direct",
        priority: "normal",
        body: { text: `seed ${i}` },
        conversation_id: `conv-inbox-limit-${i}`,
        correlation_id: `corr-inbox-limit-${i}`
      });
      expect(res.status).toBe(200);
    }
    return receiver;
  }

  it("returns 200 and one message for ?limit=1.5", async () => {
    // This test is the live request Jarvis asked for. It must fail on current
    // main and pass once inbox uses clampLimit.
    const receiver = await seedInbox(2);
    const res = await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", "/v1/inbox?limit=1.5");
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
  });

  it("clamps hostile limits instead of 500ing or returning everything", async () => {
    for (const limit of ["1.5", "-5", "0", "abc", "", "99999"]) {
      const receiver = await seedInbox(3);
      const res = await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", `/v1/inbox?limit=${limit}`);
      expect(res.status, `limit=${limit}`).toBe(200);
      expect(res.body.messages.length, `limit=${limit}`).toBeGreaterThanOrEqual(1);
      expect(res.body.messages.length, `limit=${limit}`).toBeLessThanOrEqual(3);
    }
  });

  it("truncates 1.5 to 1 and floors negatives/zero at 1", async () => {
    const fractional = await seedInbox(3);
    const onePointFive = await relay.agentRequest(fractional.agent_id, fractional.secret, "GET", "/v1/inbox?limit=1.5");
    expect(onePointFive.status).toBe(200);
    expect(onePointFive.body.messages).toHaveLength(1);

    const negative = await seedInbox(3);
    const minusFive = await relay.agentRequest(negative.agent_id, negative.secret, "GET", "/v1/inbox?limit=-5");
    expect(minusFive.status).toBe(200);
    expect(minusFive.body.messages).toHaveLength(1);

    const zero = await seedInbox(3);
    const zeroRes = await relay.agentRequest(zero.agent_id, zero.secret, "GET", "/v1/inbox?limit=0");
    expect(zeroRes.status).toBe(200);
    expect(zeroRes.body.messages).toHaveLength(1);
  });

  it("falls back on garbage and caps 99999 at 100", async () => {
    const garbage = await seedInbox(2);
    const abc = await relay.agentRequest(garbage.agent_id, garbage.secret, "GET", "/v1/inbox?limit=abc");
    expect(abc.status).toBe(200);
    expect(abc.body.messages).toHaveLength(2);

    const huge = await seedInbox(3);
    const capped = await relay.agentRequest(huge.agent_id, huge.secret, "GET", "/v1/inbox?limit=99999");
    expect(capped.status).toBe(200);
    expect(capped.body.messages).toHaveLength(3);
    expect(capped.body.messages.length).toBeLessThanOrEqual(100);
  });
});
