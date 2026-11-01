import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// The floor's catch-up tail is rendered straight into the holder's prompt, so it
// may only carry what the caller is entitled to see: messages it sent, messages
// delivered to it, and — for a room — the room's thread while it is a CURRENT
// member. Participation in a conversation (any delivery row, e.g. from an
// operator broadcast) gates the floor; it does not open every message under
// that conversation id. A refused acquire hands back no tail at all.
describe("conversation floor tail scope", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });

  type Agent = { agent_id: string; secret: string };
  type Snapshot = { text: string; message_id: string };

  function direct(from: Agent, to: Agent, conversationId: string, text: string, sig?: string) {
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
    });
  }

  async function operatorBroadcast(text: string): Promise<string> {
    const res = await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: "broadcast", text });
    expect(res.status).toBe(201);
    return res.body.conversation_id as string;
  }

  async function floor(agent: Agent, conversationId: string) {
    return relay.agentRequest(agent.agent_id, agent.secret, "POST", `/v1/conversations/${conversationId}/floor`, {});
  }

  const texts = (res: { body: { conversation_tail?: Snapshot[] } }) =>
    (res.body.conversation_tail ?? []).map((t) => t.text);

  // A, B and C all receive one operator broadcast; A and B then carry on a 1:1
  // under the broadcast's conversation id (what the plugins do when replying).
  async function broadcastThread() {
    const a = await relay.enrollAgent("tail-a");
    const b = await relay.enrollAgent("tail-b");
    const c = await relay.enrollAgent("tail-c");
    const conv = await operatorBroadcast("all-hands kickoff");
    direct(a, b, conv, "a-to-b private", "sig-a-to-b");
    direct(b, a, conv, "b-to-a private", "sig-b-to-a");
    direct(c, a, conv, "c own note");
    // Operator 1:1s threaded under the same id: one to C (C's to see), one to B (not).
    expect((await relay.operatorRequest("POST", "/v1/operator/messages", {
      recipient_agent_id: c.agent_id, conversation_id: conv, text: "operator to c"
    })).status).toBe(201);
    expect((await relay.operatorRequest("POST", "/v1/operator/messages", {
      recipient_agent_id: b.agent_id, conversation_id: conv, text: "operator to b"
    })).status).toBe(201);
    return { a, b, c, conv };
  }

  it("a broadcast participant's granted tail excludes other agents' 1:1 directs", async () => {
    const { c, conv } = await broadcastThread();

    const acq = await floor(c, conv);
    expect(acq.status).toBe(200);
    expect(acq.body.granted).toBe(true);
    const t = texts(acq);
    expect(t).toContain("all-hands kickoff");
    expect(t).toContain("c own note");
    expect(t).toContain("operator to c");
    expect(t).not.toContain("a-to-b private");
    expect(t).not.toContain("b-to-a private");
    expect(t).not.toContain("operator to b");
    // Neither the text nor the signature material of the A<->B directs leaks.
    const raw = JSON.stringify(acq.body);
    expect(raw).not.toContain("sig-a-to-b");
    expect(raw).not.toContain("sig-b-to-a");
  });

  it("a refused acquire returns no tail", async () => {
    const { b, c, conv } = await broadcastThread();
    expect((await floor(b, conv)).body.granted).toBe(true);

    const acq = await floor(c, conv);
    expect(acq.status).toBe(200);
    expect(acq.body.granted).toBe(false);
    expect(acq.body.holder_agent_id).toBe(b.agent_id);
    expect(acq.body.conversation_tail).toEqual([]);
    const raw = JSON.stringify(acq.body);
    expect(raw).not.toContain("all-hands kickoff");
    expect(raw).not.toContain("a-to-b private");
    expect(raw).not.toContain("sig-a-to-b");
  });

  it("a party to the 1:1 still gets those messages in its granted tail", async () => {
    const { b, conv } = await broadcastThread();

    const acq = await floor(b, conv);
    expect(acq.body.granted).toBe(true);
    const t = texts(acq);
    expect(t).toEqual(["all-hands kickoff", "a-to-b private", "b-to-a private", "operator to b"]);
    // Signatures on what B is entitled to see are still relayed for verification.
    const ab = acq.body.conversation_tail.find((s: Snapshot) => s.text === "a-to-b private");
    expect(ab.agent_sig).toBe("sig-a-to-b");
  });

  describe("room conversations", () => {
    async function roomThread() {
      const a = await relay.enrollAgent("room-a");
      const b = await relay.enrollAgent("room-b");
      const c = await relay.enrollAgent("room-c");
      const room = (await relay.operatorRequest("POST", "/v1/operator/rooms", {
        name: "R", member_agent_ids: [a.agent_id, b.agent_id, c.agent_id]
      })).body as { id: string };
      expect((await relay.operatorRequest("POST", "/v1/operator/messages", { room_id: room.id, text: "room kickoff" })).status).toBe(201);
      relay.db.createMessage({
        fleetId: relay.fleetId,
        senderAgentId: a.agent_id,
        recipientKind: "group",
        recipientId: room.id,
        messageType: "direct",
        priority: "normal",
        ttlSeconds: 900,
        requiresApproval: false,
        body: { text: "a in room" },
        conversationId: room.id,
        correlationId: "cor-room-a"
      });
      return { a, b, c, room };
    }

    it("a current member gets the room's history", async () => {
      const { c, room } = await roomThread();
      const acq = await floor(c, room.id);
      expect(acq.body.granted).toBe(true);
      expect(texts(acq)).toEqual(["room kickoff", "a in room"]);
    });

    it("a removed member gets none of the room's history", async () => {
      const { b, room } = await roomThread();
      relay.db.raw().prepare("DELETE FROM room_members WHERE room_id = ? AND agent_id = ?").run(room.id, b.agent_id);

      const acq = await floor(b, room.id);
      // Still a participant by its old deliveries (gating is unchanged) …
      expect(acq.status).toBe(200);
      // … but a delivery alone never grants room access.
      expect(texts(acq)).toEqual([]);
    });

    it("a non-member with a stray delivery row gets none of the room's history", async () => {
      const { room } = await roomThread();
      const d = await relay.enrollAgent("room-outsider");
      const kickoff = relay.db.raw()
        .prepare("SELECT id FROM messages WHERE conversation_id = ? ORDER BY rowid LIMIT 1")
        .get(room.id) as { id: string };
      relay.db.raw()
        .prepare("INSERT INTO message_deliveries (id, message_id, recipient_agent_id, queued_at, status) VALUES (?, ?, ?, ?, ?)")
        .run("dly_stray", kickoff.id, d.agent_id, new Date().toISOString(), "queued");

      const acq = await floor(d, room.id);
      expect(acq.status).toBe(200);
      expect(texts(acq)).toEqual([]);
      expect(JSON.stringify(acq.body)).not.toContain("room kickoff");
    });
  });

  describe("limit", () => {
    async function tailLimit() {
      const { config } = await import("../src/config");
      return config.floorTailLimit;
    }

    it("applies the limit to the visible rows, not before filtering", async () => {
      const limit = await tailLimit();
      const a = await relay.enrollAgent("lim-a");
      const b = await relay.enrollAgent("lim-b");
      const c = await relay.enrollAgent("lim-c");
      const conv = await operatorBroadcast("kickoff");
      direct(c, a, conv, "c-1");
      direct(c, a, conv, "c-2");
      // More hidden rows than the whole limit, all newer than C's visible ones.
      for (let i = 0; i < limit + 5; i++) direct(a, b, conv, `hidden-${i}`);

      const acq = await floor(c, conv);
      expect(acq.body.granted).toBe(true);
      expect(texts(acq)).toEqual(["kickoff", "c-1", "c-2"]);
    });

    it("returns the most recent visible rows up to the limit, chronologically", async () => {
      const limit = await tailLimit();
      const a = await relay.enrollAgent("lim2-a");
      const b = await relay.enrollAgent("lim2-b");
      const c = await relay.enrollAgent("lim2-c");
      const conv = await operatorBroadcast("kickoff");
      const total = limit + 5;
      for (let i = 0; i < total; i++) {
        direct(c, a, conv, `c-${i}`);
        direct(a, b, conv, `hidden-${i}`);
      }

      const acq = await floor(c, conv);
      expect(acq.body.granted).toBe(true);
      const expected = Array.from({ length: limit }, (_, k) => `c-${total - limit + k}`);
      expect(texts(acq)).toEqual(expected);
    });
  });

  it("never returns another fleet's messages under the same conversation id", async () => {
    const { conv } = await broadcastThread();
    const other = await createTestRelay();
    const x = await other.enrollAgent("other-x");
    const y = await other.enrollAgent("other-y");

    // Not a participant in its own fleet under this id -> 404, nothing leaks.
    const outsider = await other.agentRequest(x.agent_id, x.secret, "POST", `/v1/conversations/${conv}/floor`, {});
    expect(outsider.status).toBe(404);
    expect(JSON.stringify(outsider.body)).not.toContain("all-hands kickoff");

    // A participant of a same-named conversation in its own fleet sees only that fleet.
    other.db.createMessage({
      fleetId: other.fleetId,
      senderAgentId: y.agent_id,
      recipientKind: "agent",
      recipientId: x.agent_id,
      messageType: "direct",
      priority: "normal",
      ttlSeconds: 900,
      requiresApproval: false,
      body: { text: "other fleet hello" },
      conversationId: conv,
      correlationId: "cor-other"
    });
    const acq = await other.agentRequest(x.agent_id, x.secret, "POST", `/v1/conversations/${conv}/floor`, {});
    expect(acq.body.granted).toBe(true);
    expect(texts(acq)).toEqual(["other fleet hello"]);
  });
});
