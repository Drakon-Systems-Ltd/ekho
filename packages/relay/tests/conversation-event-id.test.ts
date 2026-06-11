import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// The operator console renders the conversation timeline as a React list. Each
// row needs a stable, unique identity for its key — otherwise React reuses DOM
// by position and animations/scroll jump as polls reorder the list. The natural
// identity is the event's own primary key, so the API must expose it.
describe("conversation events expose a stable id", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });

  it("returns a unique id on every event in a conversation", async () => {
    const a = await relay.enrollAgent("conv-a");
    const sent = await relay.operatorRequest("POST", "/v1/operator/messages", {
      recipient_agent_id: a.agent_id,
      text: "hello a",
    });
    const conversationId = sent.body.conversation_id as string;
    expect(conversationId).toBeTruthy();

    const res = await relay.operatorRequest("GET", `/v1/operator/conversations/${encodeURIComponent(conversationId)}`);
    expect(res.status).toBe(200);
    const events = res.body.events as Array<{ id?: string }>;
    expect(events.length).toBeGreaterThan(0);
    // every row carries a non-empty id
    expect(events.every((e) => typeof e.id === "string" && e.id.length > 0)).toBe(true);
    // and the ids are unique across the page
    const ids = events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
