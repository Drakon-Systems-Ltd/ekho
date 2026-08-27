import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

/**
 * #59 — A2A message/send and message/stream must clear the same admission gate
 * as native POST /v1/messages.
 *
 * Before the fix: handleJsonRpc only checked that request.agent existed and
 * messageSend called db.createMessage directly. requireAgentAuth authenticates a
 * quarantined or paused agent perfectly happily, so switching transport from
 * /v1/messages to /a2a bought a sender an exemption from quarantine, rate limits
 * and the policy engine — while docs/a2a.md promised the opposite.
 *
 * Every test asserts BOTH that the JSON-RPC call is refused with the right code
 * AND that nothing was delivered, so deleting the gate fails the suite loudly.
 */

// Ekho gate codes (src/a2a/jsonrpc.ts).
const EKHO_SENDER_NOT_PERMITTED = -32050;
const EKHO_RATE_LIMIT_EXCEEDED = -32051;
const EKHO_BLOCKED_BY_POLICY = -32052;

type Agent = { agent_id: string; secret: string };

function sendParams(text: string) {
  return {
    message: {
      messageId: `msg_${text.replace(/\W+/g, "_")}`,
      role: "user",
      parts: [{ kind: "text", text }],
      kind: "message",
    },
  };
}

describe("A2A shares the native message gate (#59)", () => {
  let relay: TestRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(() => relay.cleanup());

  function a2aSend(caller: Agent, target: Agent, text: string, method: "message/send" | "message/stream" = "message/send") {
    return relay.agentRequest(caller.agent_id, caller.secret, "POST", `/agents/${target.agent_id}/a2a`, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: sendParams(text),
    });
  }

  function nativeSend(caller: Agent, target: Agent, text: string, tag: string) {
    return relay.agentRequest(caller.agent_id, caller.secret, "POST", "/v1/messages", {
      recipient: { kind: "agent", id: target.agent_id },
      message_type: "direct",
      body: { text },
      conversation_id: `conv-${tag}`,
      correlation_id: `corr-${tag}`,
    });
  }

  /** Raw (unparsed) A2A request, so we can inspect headers — SSE vs JSON. */
  function rawA2a(caller: Agent, urlPath: string, payload: unknown) {
    const body = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const sha256 = (input: string) => crypto.createHash("sha256").update(input).digest("hex");
    const signature = crypto
      .createHmac("sha256", caller.secret)
      .update(`POST\n${urlPath}\n${timestamp}\n${nonce}\n${sha256(body)}`)
      .digest("hex");
    return relay.app.inject({
      method: "POST",
      url: urlPath,
      headers: {
        "content-type": "application/json",
        "x-ekho-agent-id": caller.agent_id,
        "x-ekho-agent-secret": caller.secret,
        "x-ekho-timestamp": timestamp,
        "x-ekho-nonce": nonce,
        "x-ekho-signature": signature,
      },
      payload: payload as Record<string, unknown>,
    });
  }

  function tasksFrom(agentId: string): number {
    return (
      relay.db.raw().prepare("SELECT COUNT(*) AS c FROM a2a_tasks WHERE sender_agent_id = ?").get(agentId) as {
        c: number;
      }
    ).c;
  }

  function messagesFrom(agentId: string): number {
    return (
      relay.db.raw().prepare("SELECT COUNT(*) AS c FROM messages WHERE sender_agent_id = ?").get(agentId) as {
        c: number;
      }
    ).c;
  }

  describe("quarantined / paused sender", () => {
    for (const action of ["quarantine", "pause"] as const) {
      const expected = action === "quarantine" ? "quarantined" : "paused";

      it(`rejects message/send from a ${expected} agent`, async () => {
        const sender = await relay.enrollAgent(`${action}-a2a-sender`);
        const receiver = await relay.enrollAgent(`${action}-a2a-receiver`);
        await relay.operatorRequest("POST", `/v1/operator/agents/${sender.agent_id}/${action}`, { reason: "test" });

        const res = await a2aSend(sender, receiver, "should not be delivered");

        expect(res.body.result).toBeUndefined();
        expect(res.body.error.code).toBe(EKHO_SENDER_NOT_PERMITTED);
        expect(res.body.error.message).toBe(`sender agent is ${expected}`);
        expect(res.body.error.data.status).toBe(expected);

        // Neither a task nor an Ekho message exists: the refusal is before both.
        expect(tasksFrom(sender.agent_id)).toBe(0);
        expect(messagesFrom(sender.agent_id)).toBe(0);

        // …and nothing landed in the receiver's inbox.
        const inbox = await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", "/v1/inbox");
        expect(inbox.body.messages).toHaveLength(0);
      });

      it(`rejects message/stream from a ${expected} agent without opening a stream`, async () => {
        const sender = await relay.enrollAgent(`${action}-stream-sender`);
        const receiver = await relay.enrollAgent(`${action}-stream-receiver`);
        await relay.operatorRequest("POST", `/v1/operator/agents/${sender.agent_id}/${action}`, { reason: "test" });

        const res = await rawA2a(sender, `/agents/${receiver.agent_id}/a2a`, {
          jsonrpc: "2.0",
          id: 2,
          method: "message/stream",
          params: sendParams("streamed but forbidden"),
        });

        expect(res.headers["content-type"]).not.toContain("text/event-stream");
        expect(JSON.parse(res.body).error.code).toBe(EKHO_SENDER_NOT_PERMITTED);
        expect(tasksFrom(sender.agent_id)).toBe(0);
        expect(messagesFrom(sender.agent_id)).toBe(0);
      });
    }

    it("still refuses A2A after the same agent is refused on /v1/messages", async () => {
      const sender = await relay.enrollAgent("parity-sender");
      const receiver = await relay.enrollAgent("parity-receiver");
      await relay.operatorRequest("POST", `/v1/operator/agents/${sender.agent_id}/quarantine`, { reason: "test" });

      const native = await nativeSend(sender, receiver, "native attempt", "parity");
      expect(native.status).toBe(403);
      expect(native.body.error).toBe("agent is quarantined");

      // The exemption the issue describes: same identity, same fleet, other door.
      const viaA2a = await a2aSend(sender, receiver, "a2a attempt");
      expect(viaA2a.body.error.code).toBe(EKHO_SENDER_NOT_PERMITTED);
    });

    it("lets a resumed agent send again", async () => {
      const sender = await relay.enrollAgent("resume-sender");
      const receiver = await relay.enrollAgent("resume-receiver");
      await relay.operatorRequest("POST", `/v1/operator/agents/${sender.agent_id}/quarantine`, { reason: "test" });
      await relay.operatorRequest("POST", `/v1/operator/agents/${sender.agent_id}/resume`, { reason: "test" });

      const res = await a2aSend(sender, receiver, "back in business");
      expect(res.body.error).toBeUndefined();
      expect(res.body.result.status.state).toBe("submitted");
    });
  });

  describe("rate limiting", () => {
    // setup.ts pins EKHO_RATE_LIMIT_MAX_MESSAGES=5 for the test window.
    const LIMIT = 5;

    it("counts A2A sends against the same per-agent budget and refuses over it", async () => {
      const sender = await relay.enrollAgent("rl-a2a-sender");
      const receiver = await relay.enrollAgent("rl-a2a-receiver");

      for (let i = 0; i < LIMIT; i++) {
        const ok = await a2aSend(sender, receiver, `within budget ${i}`);
        expect(ok.body.error).toBeUndefined();
      }

      const blocked = await a2aSend(sender, receiver, "over budget");
      expect(blocked.body.result).toBeUndefined();
      expect(blocked.body.error.code).toBe(EKHO_RATE_LIMIT_EXCEEDED);
      expect(blocked.body.error.message).toBe("rate limit exceeded");
      expect(blocked.body.error.data.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.body.error.data.limit).toBe(LIMIT);

      // The refused attempt minted nothing.
      expect(tasksFrom(sender.agent_id)).toBe(LIMIT);
    });

    it("shares one budget across both transports — A2A spend blocks /v1/messages", async () => {
      const sender = await relay.enrollAgent("rl-shared-sender");
      const receiver = await relay.enrollAgent("rl-shared-receiver");

      for (let i = 0; i < LIMIT; i++) {
        const ok = await a2aSend(sender, receiver, `a2a spend ${i}`);
        expect(ok.body.error).toBeUndefined();
      }

      const native = await nativeSend(sender, receiver, "native after a2a spend", "rl-shared");
      expect(native.status).toBe(429);
      expect(native.body.error).toBe("rate limit exceeded");
    });

    it("refuses an over-budget message/stream without opening a stream", async () => {
      const sender = await relay.enrollAgent("rl-stream-sender");
      const receiver = await relay.enrollAgent("rl-stream-receiver");

      for (let i = 0; i < LIMIT; i++) {
        await a2aSend(sender, receiver, `stream budget ${i}`);
      }

      const res = await rawA2a(sender, `/agents/${receiver.agent_id}/a2a`, {
        jsonrpc: "2.0",
        id: 3,
        method: "message/stream",
        params: sendParams("stream over budget"),
      });

      expect(res.headers["content-type"]).not.toContain("text/event-stream");
      expect(JSON.parse(res.body).error.code).toBe(EKHO_RATE_LIMIT_EXCEEDED);
    });
  });

  describe("policy engine", () => {
    it("applies a sender deny policy to message/send", async () => {
      const sender = await relay.enrollAgent("pol-a2a-sender");
      const receiver = await relay.enrollAgent("pol-a2a-receiver");

      await relay.operatorRequest("POST", "/v1/operator/policies", {
        name: "a2a-block-sender",
        scope_kind: "fleet",
        rule: { action: "deny", conditions: { sender_agent_id: sender.agent_id } },
        enabled: true,
      });

      const res = await a2aSend(sender, receiver, "policy should stop this");
      expect(res.body.result).toBeUndefined();
      expect(res.body.error.code).toBe(EKHO_BLOCKED_BY_POLICY);
      expect(res.body.error.data.policy).toBe("a2a-block-sender");
      expect(tasksFrom(sender.agent_id)).toBe(0);
      expect(messagesFrom(sender.agent_id)).toBe(0);
    });

    it("applies a recipient deny policy to message/send", async () => {
      const sender = await relay.enrollAgent("pol-recip-sender");
      const receiver = await relay.enrollAgent("pol-recip-receiver");
      const allowed = await relay.enrollAgent("pol-recip-allowed");

      await relay.operatorRequest("POST", "/v1/operator/policies", {
        name: "a2a-block-recipient",
        scope_kind: "fleet",
        rule: { action: "deny", conditions: { recipient_agent_id: receiver.agent_id } },
        enabled: true,
      });

      const blocked = await a2aSend(sender, receiver, "denied recipient");
      expect(blocked.body.error.code).toBe(EKHO_BLOCKED_BY_POLICY);

      // The policy is targeted, not a blanket A2A shutdown.
      const ok = await a2aSend(sender, allowed, "allowed recipient");
      expect(ok.body.error).toBeUndefined();
    });

    it("applies the a2a.message type to policies, so a type deny reaches A2A", async () => {
      const sender = await relay.enrollAgent("pol-type-sender");
      const receiver = await relay.enrollAgent("pol-type-receiver");

      await relay.operatorRequest("POST", "/v1/operator/policies", {
        name: "a2a-block-type",
        scope_kind: "fleet",
        rule: { action: "deny", conditions: { message_type: "a2a.message" } },
        enabled: true,
      });

      const res = await a2aSend(sender, receiver, "typed deny");
      expect(res.body.error.code).toBe(EKHO_BLOCKED_BY_POLICY);
      expect(res.body.error.data.policy).toBe("a2a-block-type");
    });

    it("refuses a policy-denied message/stream without opening a stream", async () => {
      const sender = await relay.enrollAgent("pol-stream-sender");
      const receiver = await relay.enrollAgent("pol-stream-receiver");

      await relay.operatorRequest("POST", "/v1/operator/policies", {
        name: "a2a-block-stream",
        scope_kind: "fleet",
        rule: { action: "deny", conditions: { sender_agent_id: sender.agent_id } },
        enabled: true,
      });

      const res = await rawA2a(sender, `/agents/${receiver.agent_id}/a2a`, {
        jsonrpc: "2.0",
        id: 4,
        method: "message/stream",
        params: sendParams("streamed but denied"),
      });

      expect(res.headers["content-type"]).not.toContain("text/event-stream");
      expect(JSON.parse(res.body).error.code).toBe(EKHO_BLOCKED_BY_POLICY);
      expect(tasksFrom(sender.agent_id)).toBe(0);
    });
  });

  describe("the gate also guards task continuation", () => {
    it("refuses to append to an existing task once the sender is quarantined", async () => {
      const sender = await relay.enrollAgent("cont-sender");
      const receiver = await relay.enrollAgent("cont-receiver");

      const first = await a2aSend(sender, receiver, "first message");
      const taskId = first.body.result.id as string;

      await relay.operatorRequest("POST", `/v1/operator/agents/${sender.agent_id}/quarantine`, { reason: "test" });

      const followUp = await relay.agentRequest(
        sender.agent_id,
        sender.secret,
        "POST",
        `/agents/${receiver.agent_id}/a2a`,
        {
          jsonrpc: "2.0",
          id: 5,
          method: "message/send",
          params: {
            message: {
              messageId: "msg_follow_up",
              role: "user",
              parts: [{ kind: "text", text: "follow up after quarantine" }],
              kind: "message",
              taskId,
            },
          },
        }
      );

      expect(followUp.body.result).toBeUndefined();
      expect(followUp.body.error.code).toBe(EKHO_SENDER_NOT_PERMITTED);

      const row = relay.db.raw().prepare("SELECT history_json FROM a2a_tasks WHERE id = ?").get(taskId) as {
        history_json: string;
      };
      expect(row.history_json).not.toContain("follow up after quarantine");
    });
  });
});
