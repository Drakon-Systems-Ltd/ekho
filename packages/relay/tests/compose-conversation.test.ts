import { describe, it, expect } from "vitest";
import { resolveOutgoingConversationId, isFeedConversation } from "../frontend/src/compose.js";

describe("isFeedConversation", () => {
  it("recognises feed threads by their feed- prefix", () => {
    expect(isFeedConversation("feed-abc123")).toBe(true);
    expect(isFeedConversation("op-1781-xyz")).toBe(false);
    expect(isFeedConversation("")).toBe(false);
    expect(isFeedConversation(undefined)).toBe(false);
  });
});

describe("resolveOutgoingConversationId", () => {
  it("threads a room message under the room id", () => {
    expect(resolveOutgoingConversationId({ isRoom: true, roomId: "room_1", selectedConversationId: "op-9" }))
      .toBe("room_1");
  });

  it("inherits the open conversation for a normal thread", () => {
    expect(resolveOutgoingConversationId({ isRoom: false, roomId: undefined, selectedConversationId: "op-9" }))
      .toBe("op-9");
  });

  it("never staples an outgoing message into an open FEED thread — starts fresh", () => {
    // The bug: broadcasting while a feed conversation is open routed the
    // broadcast into the feed. A feed is a one-way ingest; start a new thread.
    expect(resolveOutgoingConversationId({ isRoom: false, roomId: undefined, selectedConversationId: "feed-rss42" }))
      .toBeUndefined();
  });

  it("starts fresh for a direct message sent while a feed thread is open", () => {
    expect(resolveOutgoingConversationId({ isRoom: false, roomId: undefined, selectedConversationId: "feed-rss42" }))
      .toBeUndefined();
  });

  it("returns undefined when no conversation is selected", () => {
    expect(resolveOutgoingConversationId({ isRoom: false, roomId: undefined, selectedConversationId: "" }))
      .toBeUndefined();
  });
});
