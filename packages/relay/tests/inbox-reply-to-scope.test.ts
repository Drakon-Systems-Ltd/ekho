import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// An inbox delivery's reply_to is resolved into a quoted snapshot of the
// referenced message, which the plugins render into the woken agent's prompt.
// reply_to_message_id is free-form sender metadata, so naming a message must not
// be a read grant: the snapshot resolves only when the RECIPIENT may see the
// referenced message under the same rule as the floor's catch-up tail — it sent
// it; it is in a room the recipient is a current member of; or, outside a room,
// it was delivered to the recipient. Otherwise reply_to is null, exactly as for a
// reference to a message that doesn't exist.
describe("inbox reply_to snapshot scope", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });

  type Agent = { agent_id: string; secret: string };
  type InboxMessage = { message_id: string; body: { text: string }; reply_to: { message_id: string; text: string } | null };

  function direct(from: Agent, to: Agent, conversationId: string, text: string, sig?: string): string {
    return relay.db.createMessage({
      fleetId: relay.fleetId,
      senderAgentId: from.agent_id,
      recipientKind: "agent",
      recipientId: to.agent_id,
      messageType: "direct",
      priority: "normal",
      ttlSeconds: 900,
      requiresApproval: false,
      body: { text },
      metadata: sig ? { agent_sig: sig, key_id: `k-${from.agent_id}` } : undefined,
      conversationId,
      correlationId: `cor-${text}`
    }).messageId;
  }

  // Sent over the real agent API, with reply_to_message_id as the sender's own
  // metadata — the path an agent controls.
  async function send(
    from: Agent,
    recipient: { kind: "agent" | "group"; id: string },
    conversationId: string,
    text: string,
    replyTo: string
  ) {
    const res = await relay.agentRequest(from.agent_id, from.secret, "POST", "/v1/messages", {
      recipient,
      message_type: "direct",
      body: { text },
      metadata: { reply_to_message_id: replyTo },
      conversation_id: conversationId,
      correlation_id: `cor-${text}`
    });
    expect(res.status).toBe(200);
  }

  async function inbox(agent: Agent) {
    const res = await relay.agentRequest(agent.agent_id, agent.secret, "GET", "/v1/inbox");
    expect(res.status).toBe(200);
    return res.body as { messages: InboxMessage[] };
  }

  const find = (body: { messages: InboxMessage[] }, text: string) => {
    const m = body.messages.find((x) => x.body.text === text);
    expect(m, `inbox message "${text}"`).toBeTruthy();
    return m as InboxMessage;
  };

  it("does not resolve a reply_to naming another pair's 1:1 message", async () => {
    const a = await relay.enrollAgent("rt-a");
    const b = await relay.enrollAgent("rt-b");
    const c = await relay.enrollAgent("rt-c");
    const d = await relay.enrollAgent("rt-d");
    const conv = "conv-ab";
    const private1 = direct(a, b, conv, "a-to-b private", "sig-a-to-b");

    // C crafts one (addressed to itself) and receives one from D, both in the
    // same conversation as the private message and naming it as reply_to.
    await send(c, { kind: "agent", id: c.agent_id }, conv, "c crafted", private1);
    await send(d, { kind: "agent", id: c.agent_id }, conv, "d to c", private1);

    const body = await inbox(c);
    expect(find(body, "c crafted").reply_to).toBeNull();
    expect(find(body, "d to c").reply_to).toBeNull();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("a-to-b private");
    expect(raw).not.toContain("sig-a-to-b");
  });

  it("still resolves for both parties to the 1:1", async () => {
    const a = await relay.enrollAgent("rt1-a");
    const b = await relay.enrollAgent("rt1-b");
    const conv = "conv-1to1";
    const question = direct(a, b, conv, "a asks b");

    // B replies to A's message: A sees the snapshot because it sent the original.
    await send(b, { kind: "agent", id: a.agent_id }, conv, "b answers", question);
    const reply = find(await inbox(a), "b answers").reply_to;
    expect(reply?.message_id).toBe(question);
    expect(reply?.text).toBe("a asks b");

    // A follows up on its own message: B sees it because it was delivered to B.
    await send(a, { kind: "agent", id: b.agent_id }, conv, "a follows up", question);
    const followUp = find(await inbox(b), "a follows up").reply_to;
    expect(followUp?.message_id).toBe(question);
    expect(followUp?.text).toBe("a asks b");
  });

  describe("room conversations", () => {
    async function roomWith(...members: Agent[]) {
      const res = await relay.operatorRequest("POST", "/v1/operator/rooms", {
        name: "R", member_agent_ids: members.map((m) => m.agent_id)
      });
      expect(res.status).toBe(201);
      return (res.body as { id: string }).id;
    }

    function roomPost(from: Agent, roomId: string, text: string): string {
      return relay.db.createMessage({
        fleetId: relay.fleetId,
        senderAgentId: from.agent_id,
        recipientKind: "group",
        recipientId: roomId,
        messageType: "direct",
        priority: "normal",
        ttlSeconds: 900,
        requiresApproval: false,
        body: { text },
        conversationId: roomId,
        correlationId: `cor-${text}`
      }).messageId;
    }

    it("resolves for a current member replying in the room", async () => {
      const a = await relay.enrollAgent("rr-a");
      const b = await relay.enrollAgent("rr-b");
      const c = await relay.enrollAgent("rr-c");
      const room = await roomWith(a, b, c);
      const original = roomPost(a, room, "a in room");

      await send(b, { kind: "group", id: room }, room, "b replies in room", original);
      const reply = find(await inbox(c), "b replies in room").reply_to;
      expect(reply?.message_id).toBe(original);
      expect(reply?.text).toBe("a in room");
    });

    it("does not resolve for a member removed before polling", async () => {
      const a = await relay.enrollAgent("rx-a");
      const b = await relay.enrollAgent("rx-b");
      const c = await relay.enrollAgent("rx-c");
      const room = await roomWith(a, b, c);
      const original = roomPost(a, room, "a in room");
      // C takes its own delivery of the original while a member, so the next
      // poll carries only the reply.
      expect(find(await inbox(c), "a in room").reply_to).toBeNull();
      // The reply is fanned out to C while it is still a member …
      await send(b, { kind: "group", id: room }, room, "b replies in room", original);
      relay.db.raw().prepare("DELETE FROM room_members WHERE room_id = ? AND agent_id = ?").run(room, c.agent_id);

      // … but a delivery row never grants room access once membership is gone.
      const body = await inbox(c);
      expect(find(body, "b replies in room").reply_to).toBeNull();
      expect(JSON.stringify(body)).not.toContain("a in room");
    });

    it("does not resolve for an outsider once the room is deleted", async () => {
      const a = await relay.enrollAgent("rd-a");
      const b = await relay.enrollAgent("rd-b");
      const c = await relay.enrollAgent("rd-c");
      const d = await relay.enrollAgent("rd-d");
      const room = await roomWith(a, b);
      const original = roomPost(a, room, "room-only secret");
      expect((await relay.operatorRequest("DELETE", `/v1/operator/rooms/${room}`)).status).toBeLessThan(300);

      // The id no longer names a room, so a 1:1 under it is accepted; the room's
      // old messages stay behind and were never delivered to C.
      await send(d, { kind: "agent", id: c.agent_id }, room, "d to c", original);
      const body = await inbox(c);
      expect(find(body, "d to c").reply_to).toBeNull();
      expect(JSON.stringify(body)).not.toContain("room-only secret");
    });
  });
});
