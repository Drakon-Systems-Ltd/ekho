import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// Agent-raised stall notices: an agent flags a conversation whose peer-turn
// budget is exhausted (with real work withheld) so the operator can re-engage.
// Recorded as an operator-visible `conversation.stalled` event, idempotent per
// (fleet, agent, conversation) until the next operator engagement re-opens it.
describe("agent stall notices (/v1/notices)", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });

  // listEvents' type filter matches `conversation.%`; count this conversation's stalls.
  function stallCount(conv: string): number {
    const { items } = relay.db.listEvents(relay.fleetId, { type: "conversation", limit: 100, offset: 0 }) as {
      items: Array<{ event_type: string; conversation_id: string }>;
    };
    return items.filter((e) => e.event_type === "conversation.stalled" && e.conversation_id === conv).length;
  }

  it("records a conversation.stalled event the operator can see", async () => {
    const a = await relay.enrollAgent("notice-a");
    const res = await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/notices", {
      conversation_id: "conv-x",
      pending_count: 2,
      budget: 6
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, recorded: true });
    expect(stallCount("conv-x")).toBe(1);

    // Surfaces via the operator events feed the console polls.
    const ev = await relay.operatorRequest("GET", "/v1/operator/events?type=conversation");
    expect(
      ev.body.events.some(
        (e: { event_type: string; conversation_id: string }) =>
          e.event_type === "conversation.stalled" && e.conversation_id === "conv-x"
      )
    ).toBe(true);
  });

  it("is idempotent — a repeat does not add a second event", async () => {
    const a = await relay.enrollAgent("notice-idem");
    const first = await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/notices", { conversation_id: "conv-y" });
    expect(first.body.recorded).toBe(true);
    const second = await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/notices", { conversation_id: "conv-y" });
    expect(second.status).toBe(200);
    expect(second.body.recorded).toBe(false);
    expect(stallCount("conv-y")).toBe(1);
  });

  it("re-arms after an operator message re-opens the conversation", async () => {
    const a = await relay.enrollAgent("notice-reopen");
    const room = (
      await relay.operatorRequest("POST", "/v1/operator/rooms", { name: "R", member_agent_ids: [a.agent_id] })
    ).body;
    expect((await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/notices", { conversation_id: room.id })).body.recorded).toBe(true);
    // Repeat is deduped while the conversation is still stalled.
    expect((await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/notices", { conversation_id: room.id })).body.recorded).toBe(false);
    // The operator engages → re-opens the conversation.
    await relay.operatorRequest("POST", "/v1/operator/messages", { room_id: room.id, text: "back online" });
    // A fresh stall is now recordable again.
    expect((await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/notices", { conversation_id: room.id })).body.recorded).toBe(true);
    expect(stallCount(room.id)).toBe(2);
  });

  it("rejects a notice with no conversation_id", async () => {
    const a = await relay.enrollAgent("notice-bad");
    const res = await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/notices", { pending_count: 1 });
    expect(res.status).toBe(400);
  });

  it("requires agent auth", async () => {
    const res = await relay.agentRequest("nope", "nope-secret", "POST", "/v1/notices", { conversation_id: "c" });
    expect(res.status).toBe(401);
  });
});
