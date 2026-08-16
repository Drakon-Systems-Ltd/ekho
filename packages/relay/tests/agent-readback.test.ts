import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";
import { addSeconds, nowIso } from "../src/utils";

// Agent-facing read-back (#17, #22). An Ekho identity is per-box and many
// sessions share it, so "check your own transcript" returns a confident false
// negative. These endpoints make the relay's persisted state the answer:
//   GET /v1/messages/{id}/status  — did the thing I sent actually land?
//   GET /v1/conversations         — where have I (or my siblings) been talking?
//   GET /v1/sent?since=           — what have I actually said?
// Every one is scoped to the authenticated agent; the negative cases below are
// the point of the feature, not decoration.
describe("agent read-back endpoints", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });

  async function send(agent: { agent_id: string; secret: string }, to: string, text: string) {
    const res = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/messages", {
      recipient: { kind: "agent", id: to },
      message_type: "direct",
      priority: "normal",
      body: { text },
      conversation_id: `conv-${text.replace(/\W+/g, "-")}`,
      correlation_id: `corr-${text.replace(/\W+/g, "-")}`
    });
    expect(res.status).toBe(200);
    return res.body as { message_id: string; queued_at: string };
  }

  // Auth headers with a deliberately wrong signature: the shape is right, the
  // credential is not.
  function badAuthHeaders(agentId: string) {
    return {
      "content-type": "application/json",
      "x-ekho-agent-id": agentId,
      "x-ekho-agent-secret": "not-the-secret",
      "x-ekho-timestamp": new Date().toISOString(),
      "x-ekho-nonce": "nonce-bad-creds",
      "x-ekho-signature": "0".repeat(64)
    };
  }

  describe("GET /v1/messages/:message_id/status", () => {
    it("reports the relay's own view of a message the caller sent", async () => {
      const a = await relay.enrollAgent("rb-status-a");
      const b = await relay.enrollAgent("rb-status-b");
      const sent = await send(a, b.agent_id, "hello status");

      const res = await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/messages/${sent.message_id}/status`);
      expect(res.status).toBe(200);
      expect(res.body.message_id).toBe(sent.message_id);
      expect(res.body.status).toBe("queued");
      expect(res.body.expired).toBe(false);
      expect(res.body.created_at).toBe(sent.queued_at);
      expect(res.body.recipient).toEqual({ kind: "agent", id: b.agent_id });
      expect(res.body.deliveries).toHaveLength(1);
      expect(res.body.deliveries[0].recipient_agent_id).toBe(b.agent_id);
      expect(res.body.deliveries[0].status).toBe("queued");
      expect(res.body.deliveries[0].queued_at).toBeTruthy();
      expect(res.body.deliveries[0].delivered_at).toBeNull();
    });

    it("advances queued -> delivered -> acked as the recipient collects it", async () => {
      const a = await relay.enrollAgent("rb-lifecycle-a");
      const b = await relay.enrollAgent("rb-lifecycle-b");
      const sent = await send(a, b.agent_id, "lifecycle");

      await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
      let res = await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/messages/${sent.message_id}/status`);
      expect(res.body.deliveries[0].status).toBe("delivered");
      expect(res.body.deliveries[0].delivered_at).toBeTruthy();

      await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/acks", {
        acks: [{ message_id: sent.message_id, status: "received", received_at: new Date().toISOString() }]
      });
      res = await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/messages/${sent.message_id}/status`);
      expect(res.body.status).toBe("acked");
      expect(res.body.deliveries[0].status).toBe("acked");
      expect(res.body.deliveries[0].acked_at).toBeTruthy();
    });

    it("surfaces a dead-lettered delivery with its reason and timestamp", async () => {
      const a = await relay.enrollAgent("rb-dead-a");
      const b = await relay.enrollAgent("rb-dead-b");
      const sent = await send(a, b.agent_id, "doomed");
      // Age the delivery past the retry budget, then run the real retry sweep.
      relay.db
        .raw()
        .prepare("UPDATE message_deliveries SET status = 'delivered', delivered_at = ?, retry_count = 5 WHERE message_id = ?")
        .run(addSeconds(nowIso(), -1000), sent.message_id);
      expect(relay.db.sweepRetryDeliveries().deadLettered).toBe(1);

      const res = await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/messages/${sent.message_id}/status`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("dead_lettered");
      expect(res.body.deliveries[0].status).toBe("dead_lettered");
      expect(res.body.deliveries[0].dead_lettered_at).toBeTruthy();
      expect(res.body.deliveries[0].dead_letter_reason).toBe("max_retries_exceeded");
    });

    it("reports a TTL-expired message as expired — the drop that leaves no dead letter", async () => {
      const a = await relay.enrollAgent("rb-exp-a");
      const b = await relay.enrollAgent("rb-exp-b");
      const sent = await send(a, b.agent_id, "stale");
      relay.db.raw().prepare("UPDATE messages SET expires_at = ? WHERE id = ?").run(addSeconds(nowIso(), -10), sent.message_id);

      const before = await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/messages/${sent.message_id}/status`);
      expect(before.body.expired).toBe(true);

      expect(relay.db.sweepExpiredMessages()).toBeGreaterThanOrEqual(1);
      const after = await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/messages/${sent.message_id}/status`);
      expect(after.body.status).toBe("expired");
      expect(after.body.deliveries[0].status).toBe("expired");
    });

    it("404s on another agent's message id — existence is never disclosed", async () => {
      const a = await relay.enrollAgent("rb-scope-a");
      const b = await relay.enrollAgent("rb-scope-b");
      const c = await relay.enrollAgent("rb-scope-c");
      const sent = await send(a, b.agent_id, "not yours");

      // c is a total outsider to the exchange...
      const outsider = await relay.agentRequest(c.agent_id, c.secret, "GET", `/v1/messages/${sent.message_id}/status`);
      expect(outsider.status).toBe(404);
      expect(JSON.stringify(outsider.body)).not.toContain("not yours");
      expect(JSON.stringify(outsider.body)).not.toContain(a.agent_id);

      // ...and so is the RECIPIENT, for this endpoint: it is sender-scoped.
      const recipient = await relay.agentRequest(b.agent_id, b.secret, "GET", `/v1/messages/${sent.message_id}/status`);
      expect(recipient.status).toBe(404);
    });

    it("404s on a made-up message id", async () => {
      const a = await relay.enrollAgent("rb-madeup-a");
      const res = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/messages/msg_does_not_exist/status");
      expect(res.status).toBe(404);
    });

    it("401s with no credentials and with bad credentials", async () => {
      const a = await relay.enrollAgent("rb-auth-a");
      const b = await relay.enrollAgent("rb-auth-b");
      const sent = await send(a, b.agent_id, "auth guarded");

      const none = await relay.app.inject({ method: "GET", url: `/v1/messages/${sent.message_id}/status` });
      expect(none.statusCode).toBe(401);
      expect(none.body).not.toContain("auth guarded");

      const bad = await relay.app.inject({
        method: "GET",
        url: `/v1/messages/${sent.message_id}/status`,
        headers: badAuthHeaders(a.agent_id)
      });
      expect(bad.statusCode).toBe(401);
      expect(bad.body).not.toContain("auth guarded");
    });
  });

  describe("GET /v1/conversations", () => {
    it("lists threads the agent sent into, with last activity", async () => {
      const a = await relay.enrollAgent("rb-conv-a");
      const b = await relay.enrollAgent("rb-conv-b");
      await send(a, b.agent_id, "thread one");
      await send(a, b.agent_id, "thread two");

      const res = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/conversations");
      expect(res.status).toBe(200);
      const ids = res.body.conversations.map((c: { conversation_id: string }) => c.conversation_id);
      expect(ids).toContain("conv-thread-one");
      expect(ids).toContain("conv-thread-two");
      const one = res.body.conversations.find((c: { conversation_id: string }) => c.conversation_id === "conv-thread-one");
      expect(one.kind).toBe("direct");
      expect(one.sent_count).toBe(1);
      expect(one.message_count).toBe(1);
      expect(one.last_activity_at).toBeTruthy();
      // Newest activity first.
      const stamps = res.body.conversations.map((c: { last_activity_at: string }) => c.last_activity_at);
      expect([...stamps].sort().reverse()).toEqual(stamps);
    });

    it("finds a thread a SIBLING session used — the whole point of #17", async () => {
      // Two "sessions" of the same agent identity are just two calls with the
      // same credentials. Session 1 sends; session 2 (which has no transcript of
      // it) must still be able to find the thread.
      const a = await relay.enrollAgent("rb-sibling-a");
      const b = await relay.enrollAgent("rb-sibling-b");
      const sent = await send(a, b.agent_id, "said by a sibling");

      const res = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/conversations");
      const found = res.body.conversations.find(
        (c: { conversation_id: string }) => c.conversation_id === "conv-said-by-a-sibling"
      );
      expect(found).toBeTruthy();
      expect(found.sent_count).toBe(1);
      // ...and the message itself is reachable from the same credentials.
      const status = await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/messages/${sent.message_id}/status`);
      expect(status.status).toBe(200);
    });

    it("includes rooms the agent is a member of, and received threads", async () => {
      const a = await relay.enrollAgent("rb-room-a");
      const b = await relay.enrollAgent("rb-room-b");
      const room = (
        await relay.operatorRequest("POST", "/v1/operator/rooms", { name: "Readback Room", member_agent_ids: [a.agent_id, b.agent_id] })
      ).body;
      // b sends into the room; a only RECEIVES.
      await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/messages", {
        recipient: { kind: "group", id: room.id },
        message_type: "direct",
        priority: "normal",
        body: { text: "room chatter" },
        conversation_id: room.id,
        correlation_id: "corr-room"
      });

      const res = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/conversations");
      const found = res.body.conversations.find((c: { conversation_id: string }) => c.conversation_id === room.id);
      expect(found).toBeTruthy();
      expect(found.kind).toBe("room");
      expect(found.name).toBe("Readback Room");
      expect(found.message_count).toBe(1);
      expect(found.sent_count).toBe(0); // a received it, did not send it
    });

    it("does not leak conversations the agent was never in", async () => {
      const a = await relay.enrollAgent("rb-leak-a");
      const b = await relay.enrollAgent("rb-leak-b");
      const outsider = await relay.enrollAgent("rb-leak-outsider");
      await send(a, b.agent_id, "private exchange");

      const res = await relay.agentRequest(outsider.agent_id, outsider.secret, "GET", "/v1/conversations");
      expect(res.status).toBe(200);
      const ids = res.body.conversations.map((c: { conversation_id: string }) => c.conversation_id);
      expect(ids).not.toContain("conv-private-exchange");
    });

    it("401s without credentials", async () => {
      const res = await relay.app.inject({ method: "GET", url: "/v1/conversations" });
      expect(res.statusCode).toBe(401);
    });

    it("honours limit and caps it at 100", async () => {
      const a = await relay.enrollAgent("rb-limit-a");
      const b = await relay.enrollAgent("rb-limit-b");
      await send(a, b.agent_id, "lim one");
      await send(a, b.agent_id, "lim two");
      const res = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/conversations?limit=1");
      expect(res.body.conversations).toHaveLength(1);
      const huge = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/conversations?limit=99999");
      expect(huge.status).toBe(200);
      expect(huge.body.conversations.length).toBeLessThanOrEqual(100);
    });

    it("clamps hostile limits instead of 500ing", async () => {
      const a = await relay.enrollAgent("rb-badlimit-a");
      const b = await relay.enrollAgent("rb-badlimit-b");
      await send(a, b.agent_id, "bl one");
      // A fractional limit reaches SQLite as a REAL and is rejected with
      // SQLITE_MISMATCH unless it is truncated first.
      for (const limit of ["1.5", "-5", "0", "abc", ""]) {
        const res = await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/conversations?limit=${limit}`);
        expect(res.status, `limit=${limit}`).toBe(200);
        expect(Array.isArray(res.body.conversations)).toBe(true);
      }
    });
  });

  describe("GET /v1/sent", () => {
    it("returns the caller's own outbound messages with body and delivery counts", async () => {
      const a = await relay.enrollAgent("rb-sent-a");
      const b = await relay.enrollAgent("rb-sent-b");
      const sent = await send(a, b.agent_id, "did I say this");

      const res = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/sent");
      expect(res.status).toBe(200);
      expect(res.body.since).toBeNull();
      const found = res.body.messages.find((m: { message_id: string }) => m.message_id === sent.message_id);
      expect(found).toBeTruthy();
      expect(found.body.text).toBe("did I say this");
      expect(found.recipient).toEqual({ kind: "agent", id: b.agent_id });
      expect(found.status).toBe("queued");
      expect(found.deliveries).toEqual({ total: 1, queued: 1, delivered: 0, acked: 0, dead_lettered: 0 });
    });

    it("returns only this agent's sends, never a peer's", async () => {
      const a = await relay.enrollAgent("rb-sent-scope-a");
      const b = await relay.enrollAgent("rb-sent-scope-b");
      await send(a, b.agent_id, "mine alone");
      await send(b, a.agent_id, "theirs alone");

      const res = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/sent");
      const texts = res.body.messages.map((m: { body: { text: string } }) => m.body.text);
      expect(texts).toContain("mine alone");
      expect(texts).not.toContain("theirs alone");
      expect(JSON.stringify(res.body)).not.toContain("theirs alone");
    });

    it("since= actually filters (exclusive), and an empty window returns nothing", async () => {
      const a = await relay.enrollAgent("rb-since-a");
      const b = await relay.enrollAgent("rb-since-b");
      const first = await send(a, b.agent_id, "before the line");
      // The cutoff is the first message's own timestamp: exclusive, so it drops out.
      const cutoff = first.queued_at;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await send(a, b.agent_id, "after the line");

      const res = await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/sent?since=${encodeURIComponent(cutoff)}`);
      expect(res.status).toBe(200);
      expect(res.body.since).toBe(new Date(cutoff).toISOString());
      const ids = res.body.messages.map((m: { message_id: string }) => m.message_id);
      expect(ids).toContain(second.message_id);
      expect(ids).not.toContain(first.message_id);

      // A window entirely in the future is empty, not "everything".
      const future = new Date(Date.now() + 60_000).toISOString();
      const none = await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/sent?since=${encodeURIComponent(future)}`);
      expect(none.body.messages).toEqual([]);
    });

    it("400s on an unparseable since rather than silently ignoring it", async () => {
      const a = await relay.enrollAgent("rb-since-bad-a");
      const res = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/sent?since=not-a-date");
      expect(res.status).toBe(400);
    });

    it("honours limit and caps it at 100", async () => {
      const a = await relay.enrollAgent("rb-sent-limit-a");
      const b = await relay.enrollAgent("rb-sent-limit-b");
      await send(a, b.agent_id, "sl one");
      await send(a, b.agent_id, "sl two");
      const res = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/sent?limit=1");
      expect(res.body.messages).toHaveLength(1);
      // Newest first, so the cap keeps the most recent.
      expect(res.body.messages[0].body.text).toBe("sl two");
      const huge = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/sent?limit=99999");
      expect(huge.status).toBe(200);
      expect(huge.body.messages.length).toBeLessThanOrEqual(100);
    });

    it("clamps hostile limits instead of 500ing", async () => {
      const a = await relay.enrollAgent("rb-sent-badlimit-a");
      const b = await relay.enrollAgent("rb-sent-badlimit-b");
      await send(a, b.agent_id, "sbl one");
      // `?limit=1.5` used to reach SQLite as a REAL and blow up the LIMIT clause
      // with SQLITE_MISMATCH — a 500 on a read-only endpoint.
      for (const limit of ["1.5", "-5", "0", "abc", ""]) {
        const res = await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/sent?limit=${limit}`);
        expect(res.status, `limit=${limit}`).toBe(200);
        expect(res.body.messages.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("400s on a hostile since (array, garbage) rather than ignoring the filter", async () => {
      const a = await relay.enrollAgent("rb-sent-badsince-a");
      for (const q of ["since=not-a-date", "since=a&since=b", "since=%27%20OR%201%3D1--"]) {
        const res = await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/sent?${q}`);
        expect(res.status, q).toBe(400);
      }
    });

    it("401s with no credentials and with bad credentials", async () => {
      const a = await relay.enrollAgent("rb-sent-auth-a");
      const b = await relay.enrollAgent("rb-sent-auth-b");
      await send(a, b.agent_id, "sent auth guarded");

      const none = await relay.app.inject({ method: "GET", url: "/v1/sent" });
      expect(none.statusCode).toBe(401);
      expect(none.body).not.toContain("sent auth guarded");

      const bad = await relay.app.inject({ method: "GET", url: "/v1/sent", headers: badAuthHeaders(a.agent_id) });
      expect(bad.statusCode).toBe(401);
      expect(bad.body).not.toContain("sent auth guarded");
    });

    it("carries sender-supplied metadata through verbatim (#17 point 3)", async () => {
      // The relay cannot mint a session id — only the sender knows which of its
      // sessions composed a message. Metadata is relayed verbatim, so a plugin
      // that stamps one gets it back here with no further relay change.
      const a = await relay.enrollAgent("rb-meta-a");
      const b = await relay.enrollAgent("rb-meta-b");
      await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: b.agent_id },
        message_type: "direct",
        priority: "normal",
        body: { text: "stamped" },
        metadata: { origin_session_id: "sess-abc123" },
        conversation_id: "conv-meta",
        correlation_id: "corr-meta"
      });

      const res = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/sent");
      const found = res.body.messages.find((m: { body: { text: string } }) => m.body.text === "stamped");
      expect(found.metadata.origin_session_id).toBe("sess-abc123");
    });
  });
});
