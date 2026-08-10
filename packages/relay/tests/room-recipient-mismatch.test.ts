import { describe, it, expect } from "vitest";
import { createTestRelay } from "./setup";

// #12: a room-shaped conversation_id used to win over the signed recipient. A
// message signed `recipient: {kind:"agent", id:B}` but posted with a room's
// conversation_id was fanned to every member, and every member except B then
// dead-lettered it as `recipient-mismatch` — the signature binds B, so nobody
// else can verify it. The relay must fail closed on the inconsistent pair
// instead of delivering to peers who cannot accept it.
describe("room fan-out vs signed recipient (#12)", () => {
  async function roomWith(relay: Awaited<ReturnType<typeof createTestRelay>>, members: string[]) {
    return (await relay.operatorRequest("POST", "/v1/operator/rooms", { name: "R", member_agent_ids: members })).body;
  }

  it("rejects an agent-addressed message whose conversation_id is a room", async () => {
    const relay = await createTestRelay();
    const a = await relay.enrollAgent("A");
    const b = await relay.enrollAgent("B");
    const c = await relay.enrollAgent("C");
    const room = await roomWith(relay, [a.agent_id, b.agent_id, c.agent_id]);

    expect(() =>
      relay.db.createMessage({
        fleetId: relay.fleetId,
        senderAgentId: a.agent_id,
        recipientKind: "agent",
        recipientId: b.agent_id,
        messageType: "direct",
        priority: "normal",
        ttlSeconds: 900,
        requiresApproval: false,
        body: { text: "signed to B, threaded under the room" },
        conversationId: room.id,
        correlationId: "c1"
      })
    ).toThrow(/recipient/i);
  });

  it("still fans out a proper group-addressed room message", async () => {
    const relay = await createTestRelay();
    const a = await relay.enrollAgent("A");
    const b = await relay.enrollAgent("B");
    const c = await relay.enrollAgent("C");
    const room = await roomWith(relay, [a.agent_id, b.agent_id, c.agent_id]);

    const res = relay.db.createMessage({
      fleetId: relay.fleetId,
      senderAgentId: a.agent_id,
      recipientKind: "group",
      recipientId: room.id,
      messageType: "direct",
      priority: "normal",
      ttlSeconds: 900,
      requiresApproval: false,
      body: { text: "hello room" },
      conversationId: room.id,
      correlationId: "c2"
    });
    expect(res.messageId).toBeTruthy();

    const rows = relay.db.db
      .prepare("SELECT recipient_agent_id FROM message_deliveries WHERE message_id = ?")
      .all(res.messageId) as Array<{ recipient_agent_id: string }>;
    expect(rows.map((r) => r.recipient_agent_id).sort()).toEqual([b.agent_id, c.agent_id].sort());
  });

  it("leaves a normal 1:1 send on a non-room conversation alone", async () => {
    const relay = await createTestRelay();
    const a = await relay.enrollAgent("A");
    const b = await relay.enrollAgent("B");

    const res = relay.db.createMessage({
      fleetId: relay.fleetId,
      senderAgentId: a.agent_id,
      recipientKind: "agent",
      recipientId: b.agent_id,
      messageType: "direct",
      priority: "normal",
      ttlSeconds: 900,
      requiresApproval: false,
      body: { text: "direct" },
      conversationId: "oc-plain",
      correlationId: "c3"
    });
    const rows = relay.db.db
      .prepare("SELECT recipient_agent_id FROM message_deliveries WHERE message_id = ?")
      .all(res.messageId) as Array<{ recipient_agent_id: string }>;
    expect(rows.map((r) => r.recipient_agent_id)).toEqual([b.agent_id]);
  });

  it("does not reject when the sender is not a member (no fan-out was possible)", async () => {
    // A non-member addressing an agent while quoting a room id it isn't in gets
    // ordinary 1:1 delivery — roomMemberIds already refuses the fan-out, and
    // there is no inconsistency to fail closed on.
    const relay = await createTestRelay();
    const a = await relay.enrollAgent("A");
    const b = await relay.enrollAgent("B");
    const outsider = await relay.enrollAgent("Outsider");
    const room = await roomWith(relay, [a.agent_id, b.agent_id]);

    const res = relay.db.createMessage({
      fleetId: relay.fleetId,
      senderAgentId: outsider.agent_id,
      recipientKind: "agent",
      recipientId: b.agent_id,
      messageType: "direct",
      priority: "normal",
      ttlSeconds: 900,
      requiresApproval: false,
      body: { text: "direct from outside" },
      conversationId: room.id,
      correlationId: "c4"
    });
    const rows = relay.db.db
      .prepare("SELECT recipient_agent_id FROM message_deliveries WHERE message_id = ?")
      .all(res.messageId) as Array<{ recipient_agent_id: string }>;
    expect(rows.map((r) => r.recipient_agent_id)).toEqual([b.agent_id]);
  });
});
