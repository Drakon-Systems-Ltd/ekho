import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// The conversations list must come from actual messages, not the recent-events
// firehose — heartbeats from a busy fleet otherwise bury every thread and the
// operator can't navigate to where agents replied.
describe("overview recent conversations", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });

  it("surfaces recent conversations by last message, newest first, with a preview", async () => {
    const a = await relay.enrollAgent("ov-a");
    await relay.operatorRequest("POST", "/v1/operator/messages", {
      recipient_agent_id: a.agent_id, text: "the first thread", conversation_id: "conv-A"
    });
    await relay.operatorRequest("POST", "/v1/operator/messages", {
      recipient_agent_id: a.agent_id, text: "the second thread", conversation_id: "conv-B"
    });

    const ov = await relay.operatorRequest("GET", "/v1/operator/overview");
    const convs = ov.body.recentConversations;
    expect(Array.isArray(convs)).toBe(true);
    const ids = convs.map((c: { conversation_id: string }) => c.conversation_id);
    expect(ids).toContain("conv-A");
    expect(ids).toContain("conv-B");
    // newest (conv-B) first
    expect(ids[0]).toBe("conv-B");
    const b = convs.find((c: { conversation_id: string }) => c.conversation_id === "conv-B");
    expect(b.preview).toContain("the second thread");
    expect(b.last_at).toBeTruthy();
  });

  it("titles a room by its name and a direct conversation by the agent", async () => {
    const a = await relay.enrollAgent("ov-titled");
    const room = (await relay.operatorRequest("POST", "/v1/operator/rooms", {
      name: "ProjectX", member_agent_ids: [a.agent_id]
    })).body;
    await relay.operatorRequest("POST", "/v1/operator/messages", { room_id: room.id, text: "in the room" });
    await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: a.agent_id, text: "direct one", conversation_id: "direct-1" });

    const ov = await relay.operatorRequest("GET", "/v1/operator/overview");
    const byId = Object.fromEntries(ov.body.recentConversations.map((c: { conversation_id: string }) => [c.conversation_id, c]));
    expect(byId[room.id].title).toBe("# ProjectX");
    expect(byId["direct-1"].title).toContain("ov-titled");
  });

  it("returns one entry per conversation (latest message wins)", async () => {
    const a = await relay.enrollAgent("ov-dup-a");
    await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: a.agent_id, text: "older", conversation_id: "conv-X" });
    await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: a.agent_id, text: "newer", conversation_id: "conv-X" });
    const ov = await relay.operatorRequest("GET", "/v1/operator/overview");
    const xs = ov.body.recentConversations.filter((c: { conversation_id: string }) => c.conversation_id === "conv-X");
    expect(xs.length).toBe(1);
    expect(xs[0].preview).toContain("newer");
  });

  it("reports participants + kind so a multi-agent thread can never masquerade as a DM", async () => {
    const a = await relay.enrollAgent("part-a");
    const b = await relay.enrollAgent("part-b");

    // A true 1:1 DM: operator ↔ a.
    await relay.operatorRequest("POST", "/v1/operator/messages", {
      recipient_agent_id: a.agent_id, text: "just us", conversation_id: "solo-1"
    });

    // A multi-agent working thread: a↔b talk, then a reports to the operator —
    // the LAST speaker is a, which used to title (and classify) it like a's DM.
    await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/messages", {
      recipient: { kind: "agent", id: b.agent_id }, message_type: "direct",
      body: { text: "b, take a look" }, conversation_id: "thread-ab", correlation_id: "c1"
    });
    await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/messages", {
      recipient: { kind: "agent", id: a.agent_id }, message_type: "direct",
      body: { text: "on it" }, conversation_id: "thread-ab", correlation_id: "c2"
    });

    const ov = await relay.operatorRequest("GET", "/v1/operator/overview");
    const byId = Object.fromEntries(ov.body.recentConversations.map((c: { conversation_id: string }) => [c.conversation_id, c]));

    expect(byId["solo-1"].kind).toBe("dm");
    expect(byId["solo-1"].participants).toEqual([a.agent_id]);

    expect(byId["thread-ab"].kind).toBe("group");
    expect(byId["thread-ab"].participants.sort()).toEqual([a.agent_id, b.agent_id].sort());
    // Group titles name the cast, not one agent — so the row can't be mistaken
    // for (or hijack) either agent's 1:1 thread.
    expect(byId["thread-ab"].title).toContain("part-a");
    expect(byId["thread-ab"].title).toContain("part-b");
  });
});
