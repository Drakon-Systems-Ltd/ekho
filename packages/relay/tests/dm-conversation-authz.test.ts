import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";
import { canonicalDmId } from "../src/db";

// Canonical DM conversations (dm-<fleet>-<agent>) are the operator's 1:1 channel
// with ONE agent. An authenticated agent may post under its OWN canonical DM
// (and rooms it belongs to). Posting, the floor, the tail and stall notices for
// a canonical DM are limited to its owner, however a send is addressed (self,
// another agent, broadcast) and whatever rows are stored under it.
describe("canonical DM conversation authorization", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(() => relay.cleanup());

  const peerSend = (
    sender: { agent_id: string; secret: string },
    recipient: { kind: string; id?: string },
    conversation_id: string,
    text: string
  ) =>
    relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
      recipient,
      conversation_id,
      correlation_id: `cor-${Math.random().toString(36).slice(2)}`,
      message_type: "direct",
      priority: "normal",
      body: { text }
    });

  function rowsIn(conversationId: string) {
    const raw = (relay.db as unknown as { db: { prepare: (s: string) => { all: (...a: unknown[]) => Array<Record<string, unknown>> } } }).db;
    return raw.prepare("SELECT id, sender_agent_id, body_json FROM messages WHERE fleet_id = ? AND conversation_id = ?").all(relay.fleetId, conversationId);
  }
  function deliveriesFor(messageIds: string[]) {
    if (messageIds.length === 0) return [];
    const raw = (relay.db as unknown as { db: { prepare: (s: string) => { all: (...a: unknown[]) => Array<Record<string, unknown>> } } }).db;
    const ph = messageIds.map(() => "?").join(",");
    return raw.prepare(`SELECT id, recipient_agent_id FROM message_deliveries WHERE message_id IN (${ph})`).all(...messageIds);
  }

  async function ownerWithOperatorDm() {
    const owner = await relay.enrollAgent("dm-owner");
    const dm = canonicalDmId(relay.fleetId, owner.agent_id);
    const op = await relay.operatorRequest("POST", "/v1/operator/messages", {
      recipient_agent_id: owner.agent_id,
      text: "operator-dm-text"
    });
    expect(op.status).toBe(201);
    expect(op.body.conversation_id).toBe(dm);
    return { owner, dm };
  }

  it("rejects an agent posting into another agent's canonical DM addressed to a third agent (no row, no delivery)", async () => {
    const { owner, dm } = await ownerWithOperatorDm();
    const other = await relay.enrollAgent("dm-other");
    const third = await relay.enrollAgent("dm-third");
    const before = rowsIn(dm).length;

    const res = await peerSend(other, { kind: "agent", id: third.agent_id }, dm, "cross-dm-post");
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("operator-dm-text");

    const after = rowsIn(dm);
    expect(after.length).toBe(before);
    expect(after.some((r) => String(r.body_json).includes("cross-dm-post"))).toBe(false);
    expect(deliveriesFor(after.map((r) => String(r.id))).some((d) => d.recipient_agent_id === third.agent_id)).toBe(false);
    void owner;
  });

  it("rejects a self-addressed send into another agent's canonical DM", async () => {
    const { dm } = await ownerWithOperatorDm();
    const other = await relay.enrollAgent("dm-other-self");
    const before = rowsIn(dm).length;

    const res = await peerSend(other, { kind: "agent", id: other.agent_id }, dm, "self-addressed-post");
    expect(res.status).toBe(403);
    expect(rowsIn(dm).length).toBe(before);
  });

  it("rejects a broadcast threaded under another agent's canonical DM", async () => {
    const { dm } = await ownerWithOperatorDm();
    const other = await relay.enrollAgent("dm-other-bc");
    await relay.enrollAgent("dm-bystander");
    const before = rowsIn(dm).length;

    const res = await peerSend(other, { kind: "broadcast" }, dm, "broadcast-post");
    expect(res.status).toBe(403);
    expect(rowsIn(dm).length).toBe(before);
  });

  it("rejects a reply to the operator that names another agent's DM by storing it under the sender's own DM", async () => {
    const { dm } = await ownerWithOperatorDm();
    const other = await relay.enrollAgent("dm-other-op");
    const before = rowsIn(dm).length;

    const res = await peerSend(other, { kind: "agent", id: `op_${relay.fleetId}` }, dm, "op-reply-under-foreign-dm");
    expect(res.status).toBe(200);
    expect(rowsIn(dm).length).toBe(before);
    const own = rowsIn(canonicalDmId(relay.fleetId, other.agent_id));
    expect(own.some((r) => String(r.body_json).includes("op-reply-under-foreign-dm"))).toBe(true);
  });

  it("denies the floor and tail of another agent's canonical DM to a non-owner", async () => {
    const { dm } = await ownerWithOperatorDm();
    const other = await relay.enrollAgent("dm-floor-other");

    const acq = await relay.agentRequest(other.agent_id, other.secret, "POST", `/v1/conversations/${dm}/floor`, {});
    expect(acq.status).toBe(404);
    expect(JSON.stringify(acq.body)).not.toContain("operator-dm-text");
    const rel = await relay.agentRequest(other.agent_id, other.secret, "DELETE", `/v1/conversations/${dm}/floor`);
    expect(rel.status).toBe(404);
  });

  it("derives DM participation from the id alone, whatever rows are stored under it", async () => {
    const { owner, dm } = await ownerWithOperatorDm();
    const other = await relay.enrollAgent("dm-stored-row");
    // Fixture written directly to the store: a message under the DM sent by a
    // non-owner, with a delivery to that same agent.
    const raw = (relay.db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
    const now = new Date().toISOString();
    raw.prepare(
      `INSERT INTO messages (id, fleet_id, conversation_id, correlation_id, sender_agent_id, recipient_kind, recipient_id,
         message_type, priority, requires_approval, body_json, metadata_json, ttl_seconds, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, 'agent', ?, 'task', 'normal', 0, ?, NULL, 3600, ?, ?, 'queued')`
    ).run("msg_fixture_1", relay.fleetId, dm, "cor_fixture", other.agent_id, other.agent_id, JSON.stringify({ text: "fixture" }), now, now);
    raw.prepare("INSERT INTO message_deliveries (id, message_id, recipient_agent_id, queued_at, status) VALUES (?, ?, ?, ?, ?)")
      .run("dly_fixture_1", "msg_fixture_1", other.agent_id, now, "queued");

    expect(relay.db.isConversationParticipant(relay.fleetId, dm, other.agent_id)).toBe(false);
    const acq = await relay.agentRequest(other.agent_id, other.secret, "POST", `/v1/conversations/${dm}/floor`, {});
    expect(acq.status).toBe(404);
    expect(JSON.stringify(acq.body)).not.toContain("operator-dm-text");

    // The DM owner is still a participant.
    expect(relay.db.isConversationParticipant(relay.fleetId, dm, owner.agent_id)).toBe(true);
  });

  it("rejects a stall notice raised against another agent's canonical DM", async () => {
    const { dm } = await ownerWithOperatorDm();
    const other = await relay.enrollAgent("dm-stall-other");
    const res = await relay.agentRequest(other.agent_id, other.secret, "POST", "/v1/notices", {
      conversation_id: dm,
      reason: "peer_budget_exhausted",
      pending_count: 1,
      budget: 1
    });
    expect(res.status).toBe(404);
    const events = await relay.operatorRequest("GET", `/v1/operator/conversations/${encodeURIComponent(dm)}`);
    expect(JSON.stringify(events.body)).not.toContain(other.agent_id);
  });

  it("preserves the owner's legitimate use of its own DM: reply to operator, floor + tail, stall notice", async () => {
    const { owner, dm } = await ownerWithOperatorDm();

    const reply = await peerSend(owner, { kind: "agent", id: `op_${relay.fleetId}` }, dm, "owner-reply");
    expect(reply.status).toBe(200);

    const acq = await relay.agentRequest(owner.agent_id, owner.secret, "POST", `/v1/conversations/${dm}/floor`, {});
    expect(acq.status).toBe(200);
    expect(acq.body.granted).toBe(true);
    const texts = (acq.body.conversation_tail as Array<{ text: string }>).map((t) => t.text);
    expect(texts).toContain("operator-dm-text");
    expect(texts).toContain("owner-reply");

    const stall = await relay.agentRequest(owner.agent_id, owner.secret, "POST", "/v1/notices", {
      conversation_id: dm,
      reason: "peer_budget_exhausted",
      pending_count: 1,
      budget: 1
    });
    expect(stall.status).toBe(200);
  });

  it("rejects DM delegation with an actionable ordinary-thread path and completes the peer request/reply there", async () => {
    const { owner, dm } = await ownerWithOperatorDm();
    const peer = await relay.enrollAgent("roundtrip-peer");
    const before = rowsIn(dm);
    const rejected = await peerSend(owner, { kind: "agent", id: peer.agent_id }, dm, "delegate-task");
    expect(rejected.status).toBe(403);
    expect(rejected.body.error).toContain("fresh non-dm- conversation_id");
    expect(rejected.body.error).toContain("omit conversation_id in ekho_send");
    expect(rowsIn(dm)).toEqual(before);
    expect((await relay.agentRequest(peer.agent_id, peer.secret, "GET", "/v1/inbox")).body.messages).toHaveLength(0);

    // ekho_send mints oc-... when conversation_id is omitted. The peer uses
    // the delivered sender and conversation, exactly as autoreply instructs.
    const thread = "oc-roundtrip-delegation";
    expect((await peerSend(owner, { kind: "agent", id: peer.agent_id }, thread, "delegate-task")).status).toBe(200);
    const inbox = await relay.agentRequest(peer.agent_id, peer.secret, "GET", "/v1/inbox");
    const request = inbox.body.messages[0];
    expect(request.conversation_id).toBe(thread);
    expect(request.sender_agent_id).toBe(owner.agent_id);
    expect(JSON.stringify(inbox.body)).not.toContain("operator-dm-text");
    const response = await peerSend(peer, { kind: "agent", id: request.sender_agent_id }, request.conversation_id, "task-result");
    expect(response.status).toBe(200);
    const ownerInbox = await relay.agentRequest(owner.agent_id, owner.secret, "GET", "/v1/inbox");
    expect(ownerInbox.body.messages.some((m: { conversation_id: string; body: { text: string } }) => m.conversation_id === thread && m.body.text === "task-result")).toBe(true);
    expect(rowsIn(thread)).toHaveLength(2);
    const floor = await relay.agentRequest(peer.agent_id, peer.secret, "POST", "/v1/conversations/" + thread + "/floor", {});
    expect(floor.status).toBe(200);
    expect(JSON.stringify(floor.body)).not.toContain("operator-dm-text");
    const privateFloor = await relay.agentRequest(peer.agent_id, peer.secret, "POST", "/v1/conversations/" + dm + "/floor", {});
    expect(privateFloor.status).toBe(404);
    expect(JSON.stringify(privateFloor.body)).not.toContain("operator-dm-text");
    expect((await peerSend(peer, { kind: "agent", id: owner.agent_id }, dm, "peer-dm-reply")).status).toBe(403);
    expect(rowsIn(dm)).toEqual(before);
  });

  it("rejects self and broadcast delegation under the owner's DM without delivery", async () => {
    const { owner, dm } = await ownerWithOperatorDm();
    const peer = await relay.enrollAgent("broadcast-peer");
    const before = rowsIn(dm);
    for (const recipient of [{ kind: "agent", id: owner.agent_id }, { kind: "broadcast" }]) {
      const res = await peerSend(owner, recipient, dm, "unsupported-delegation");
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("fresh non-dm- conversation_id");
    }
    expect(rowsIn(dm)).toEqual(before);
    expect((await relay.agentRequest(peer.agent_id, peer.secret, "GET", "/v1/inbox")).body.messages).toHaveLength(0);
  });

  it("preserves room posting for members and ordinary non-DM threads", async () => {
    const a = await relay.enrollAgent("dm-room-a");
    const b = await relay.enrollAgent("dm-room-b");
    const room = (await relay.operatorRequest("POST", "/v1/operator/rooms", { name: "R", member_agent_ids: [a.agent_id, b.agent_id] })).body;

    const inRoom = await peerSend(a, { kind: "group", id: room.id }, room.id, "room-post");
    expect(inRoom.status).toBe(200);
    expect(rowsIn(room.id).some((r) => String(r.body_json).includes("room-post"))).toBe(true);

    const thread = await peerSend(a, { kind: "agent", id: b.agent_id }, "oc-1234-thread", "plain-thread");
    expect(thread.status).toBe(200);
    expect(rowsIn("oc-1234-thread").length).toBe(1);
  });
});
