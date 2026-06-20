import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// Feed deliveries are stored as messages but record no message.queued event, so
// the event-based timeline only ever showed "feed · delivered" receipts. A feed
// conversation must instead render its actual items (the headlines) from the
// messages table, so the operator can scroll the history of what agents are fed.
describe("feed conversation history", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });

  function seedFeedItem(conv: string, id: string, text: string, feed: string, createdAt: string) {
    const sender = relay.db.ensureOperatorAgent(relay.fleetId); // FK-valid sender
    relay.db.raw().prepare(
      `INSERT INTO messages (id, fleet_id, conversation_id, correlation_id, sender_agent_id, recipient_kind, recipient_id,
        message_type, priority, requires_approval, body_json, metadata_json, ttl_seconds, created_at, expires_at, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, relay.fleetId, conv, "cor_" + id, sender, "broadcast", null, "feed", "low", 0,
      JSON.stringify({ text, feed }), "{}", 3600, createdAt, "2030-01-01T00:00:00.000Z", "queued");
  }

  it("renders a feed thread's items (headlines) from messages, chronologically", () => {
    const conv = "feed-test1";
    seedFeedItem(conv, "msg_f1", "📰 [HN] Headline One", "HN", "2026-06-01T10:00:00.000Z");
    seedFeedItem(conv, "msg_f2", "📰 [HN] Headline Two", "HN", "2026-06-01T11:00:00.000Z");

    const res = relay.db.getConversation(relay.fleetId, conv, { sortOrder: "asc", limit: 100, offset: 0 });
    expect(res.total).toBe(2);
    expect(res.items.length).toBe(2);
    // each item renders as a message (so the frontend draws a bubble, not a chip)
    expect(res.items.every((i: Record<string, unknown>) => i.event_type === "message.queued")).toBe(true);
    expect(res.items.every((i: Record<string, unknown>) => i.resource_kind === "message")).toBe(true);
    // the headline text is carried (chronological order)
    const texts = res.items.map((i: Record<string, unknown>) => JSON.parse(String(i.message_body_json)).text);
    expect(texts).toEqual(["📰 [HN] Headline One", "📰 [HN] Headline Two"]);
    // each row has a stable id for the React key
    expect(res.items.every((i: Record<string, unknown>) => typeof i.id === "string" && (i.id as string).length > 0)).toBe(true);
  });

  it("caps to the newest page while reporting the full total", () => {
    const conv = "feed-test2";
    for (let i = 0; i < 5; i++) {
      seedFeedItem(conv, `m${i}`, `📰 item ${i}`, "HN", `2026-06-01T1${i}:00:00.000Z`);
    }
    const res = relay.db.getConversation(relay.fleetId, conv, { limit: 2, offset: 0 });
    expect(res.total).toBe(5); // full history counted
    expect(res.items.length).toBe(2); // page capped
    // the NEWEST two, in chronological order
    const texts = res.items.map((i: Record<string, unknown>) => JSON.parse(String(i.message_body_json)).text);
    expect(texts).toEqual(["📰 item 3", "📰 item 4"]);
  });
});
