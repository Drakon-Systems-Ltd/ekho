import crypto from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
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
const EKHO_BLOCKED_BY_EXTENSION = -32053;

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
  function rawA2a(caller: Agent, urlPath: string, payload: unknown, injectOpts: { payloadAsStream?: boolean } = {}) {
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
      ...injectOpts,
    });
  }

  /** The parts of a payloadAsStream inject response the stream observer reads. */
  type StreamedReply = {
    headers: Record<string, string | string[] | number | undefined>;
    stream(): AsyncIterable<Buffer | string>;
    raw: { res: { req: { emit(event: "close"): boolean }; writableEnded: boolean } };
  };

  type StreamVerdict =
    | { kind: "refused"; contentType: string; body: { error?: { code: number } } }
    | { kind: "admitted"; ended: boolean };

  function isEventStream(res: StreamedReply) {
    return String(res.headers["content-type"] ?? "").includes("text/event-stream");
  }

  async function readStreamed(res: StreamedReply) {
    let text = "";
    for await (const chunk of res.stream()) text += chunk.toString();
    return text;
  }

  /**
   * Send a message/stream and classify it at header time, not at end of body:
   * payloadAsStream resolves the inject on writeHead, so a refusal (plain JSON)
   * and an admission (SSE) are told apart as soon as either is written, and an
   * opened stream never has to end for the test to see it.
   *
   * `outcome` is "inconclusive" when no headers arrive within `deadlineMs` —
   * a slow reply is not evidence of admission. `settled` resolves whenever the
   * reply finally arrives, before or after the deadline. An SSE reply is ended
   * through ITS OWN request's "close" event — what a disconnecting client emits
   * and what openSseStream tears down on (keep-alive cleared, bus unsubscribed,
   * reply ended) — never by emitting on a task looked up by recency, which
   * could be another request's.
   *
   * No AbortController: light-my-request ignores abort once the request body
   * has been read (before the handler runs), and with payloadAsStream an abort
   * before headers errors a response stream nobody can listen on yet.
   */
  async function observeStream(caller: Agent, urlPath: string, payload: unknown, deadlineMs = 5_000) {
    const pending = rawA2a(caller, urlPath, payload, { payloadAsStream: true }) as unknown as Promise<StreamedReply>;
    const settled = pending.then<StreamVerdict>(async (res) => {
      if (isEventStream(res)) {
        res.raw.res.req.emit("close");
        return { kind: "admitted", ended: res.raw.res.writableEnded };
      }
      return {
        kind: "refused",
        contentType: String(res.headers["content-type"] ?? ""),
        body: JSON.parse(await readStreamed(res)),
      };
    });
    // Rejections surface through `settled`; keep an unawaited one quiet.
    settled.catch(() => {});

    const DEADLINE = Symbol("deadline");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([
      settled,
      new Promise<typeof DEADLINE>((resolve) => {
        timer = setTimeout(() => resolve(DEADLINE), deadlineMs);
      }),
    ]).finally(() => clearTimeout(timer));

    const outcome: StreamVerdict | { kind: "inconclusive" } = first === DEADLINE ? { kind: "inconclusive" } : first;
    return { outcome, settled };
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

    // The limiter's buckets are fixed wall-clock windows (db.ts
    // checkAndIncrementRateLimit), 5 s here. A boundary crossed between the
    // budget sends and the over-budget attempt opens a fresh bucket that
    // legitimately admits it — main CI runs 37410765690 and 37845636165 lost the
    // stream test that way. Freeze only Date so every send lands in one bucket;
    // timers and I/O stay real. afterEach restores it even when a test fails.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

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
        const ok = await a2aSend(sender, receiver, `stream budget ${i}`);
        expect(ok.body.error).toBeUndefined();
      }
      expect(tasksFrom(sender.agent_id)).toBe(LIMIT);
      expect(messagesFrom(sender.agent_id)).toBe(LIMIT);

      // A refusal is plain JSON; an admission opens SSE, which only ends on a
      // final task event. observeStream tells them apart at header time and
      // ends a stray stream through its own request, so neither outcome can
      // outlive the test or read as a hang.
      const { outcome } = await observeStream(sender, `/agents/${receiver.agent_id}/a2a`, {
        jsonrpc: "2.0",
        id: 3,
        method: "message/stream",
        params: sendParams("stream over budget"),
      });
      if (outcome.kind === "inconclusive") {
        throw new Error(
          `over-budget message/stream inconclusive: no response headers within 5000 ms, so neither the ` +
            `${EKHO_RATE_LIMIT_EXCEEDED} refusal nor an SSE admission was observed ` +
            `(${tasksFrom(sender.agent_id)} tasks from sender, budget ${LIMIT})`
        );
      }
      if (outcome.kind === "admitted") {
        throw new Error(
          `over-budget message/stream was admitted: SSE opened instead of a ${EKHO_RATE_LIMIT_EXCEEDED} refusal ` +
            `(${tasksFrom(sender.agent_id)} tasks from sender, budget ${LIMIT}; stream ended: ${outcome.ended})`
        );
      }

      expect(outcome.contentType).not.toContain("text/event-stream");
      expect(outcome.body.error?.code).toBe(EKHO_RATE_LIMIT_EXCEEDED);

      // The refusal left nothing behind: no task, no Ekho message, no delivery.
      expect(tasksFrom(sender.agent_id)).toBe(LIMIT);
      expect(messagesFrom(sender.agent_id)).toBe(LIMIT);
      const inbox = await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", "/v1/inbox");
      expect(inbox.body.messages).toHaveLength(LIMIT);
      expect(JSON.stringify(inbox.body.messages)).not.toContain("stream over budget");
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

  describe("message/stream observer under delayed admission", () => {
    // The gate awaits every licensed extension's onBeforeMessage before any task
    // or message exists — the one real async step in admission. A test extension
    // holds that step for a single sender until the test settles it, so "slower
    // than the deadline" is a fact of the test, not of CI load. The registry has
    // no unregister: the hook is inert for every sender but the held one.
    let held: { senderId: string; gate: Promise<void>; refuse(reason: Error): void } | null = null;

    beforeAll(async () => {
      const { registerExtension } = await import("../src/license");
      registerExtension({
        name: "test-admission-hold",
        async onBeforeMessage(ctx) {
          if (held && ctx.senderAgentId === held.senderId) await held.gate;
        },
      });
    });
    // A test that fails before settling its hold must not leave the request
    // parked in the gate: refuse it, which writes JSON and mints nothing.
    afterEach(() => {
      held?.refuse(new Error("test ended with admission held"));
      held = null;
    });

    function holdAdmission(sender: Agent) {
      let admit!: () => void;
      let refuse!: (reason: Error) => void;
      const gate = new Promise<void>((resolve, reject) => {
        admit = resolve;
        refuse = reject;
      });
      // The extension may not be awaiting yet when the test refuses.
      gate.catch(() => {});
      held = { senderId: sender.agent_id, gate, refuse };
      return { admit, refuse };
    }

    function streamTo(sender: Agent, receiver: Agent, text: string) {
      return observeStream(
        sender,
        `/agents/${receiver.agent_id}/a2a`,
        { jsonrpc: "2.0", id: 6, method: "message/stream", params: sendParams(text) },
        50
      );
    }

    it("reports a held admission as inconclusive, then ends that request's stream when it opens", async () => {
      const sender = await relay.enrollAgent("hold-admit-sender");
      const receiver = await relay.enrollAgent("hold-admit-receiver");
      const hold = holdAdmission(sender);

      const { outcome, settled } = await streamTo(sender, receiver, "held then admitted");
      expect(outcome.kind).toBe("inconclusive");
      expect(tasksFrom(sender.agent_id)).toBe(0);

      hold.admit();
      const late = await settled;
      expect(late).toEqual({ kind: "admitted", ended: true });
      expect(tasksFrom(sender.agent_id)).toBe(1);
    });

    it("reports a held refusal as inconclusive, never as an opened stream", async () => {
      const sender = await relay.enrollAgent("hold-refuse-sender");
      const receiver = await relay.enrollAgent("hold-refuse-receiver");
      const hold = holdAdmission(sender);

      const { outcome, settled } = await streamTo(sender, receiver, "held then refused");
      expect(outcome.kind).toBe("inconclusive");

      hold.refuse(new Error("held refusal"));
      const late = await settled;
      expect(late.kind).toBe("refused");
      if (late.kind !== "refused") return;
      expect(late.contentType).not.toContain("text/event-stream");
      expect(late.body.error?.code).toBe(EKHO_BLOCKED_BY_EXTENSION);

      expect(tasksFrom(sender.agent_id)).toBe(0);
      expect(messagesFrom(sender.agent_id)).toBe(0);
      const inbox = await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", "/v1/inbox");
      expect(inbox.body.messages).toHaveLength(0);
    });
  });
});
