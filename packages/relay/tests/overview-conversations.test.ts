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

  it("returns one entry per conversation (latest message wins)", async () => {
    const a = await relay.enrollAgent("ov-dup-a");
    await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: a.agent_id, text: "older", conversation_id: "conv-X" });
    await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: a.agent_id, text: "newer", conversation_id: "conv-X" });
    const ov = await relay.operatorRequest("GET", "/v1/operator/overview");
    const xs = ov.body.recentConversations.filter((c: { conversation_id: string }) => c.conversation_id === "conv-X");
    expect(xs.length).toBe(1);
    expect(xs[0].preview).toContain("newer");
  });
});
