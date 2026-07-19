import { describe, it, expect } from "vitest";
import { dmChannelKey, groupConversationsByChannel } from "../frontend/src/channels.js";

// The console mirrors the relay's canonical channel ids so a row's label and the
// conversation it opens are the SAME pure function of identity — no stale cache,
// no guessing (the fix for "Friday · No messages yet → Friday + Jarvis").
describe("channels — dmChannelKey", () => {
  it("mirrors the relay canonicalDmId format", () => {
    expect(dmChannelKey("flt_x", "agent_y")).toBe("dm-flt_x-agent_y");
  });
});

describe("channels — groupConversationsByChannel", () => {
  it("collapses same-channel scattered conversations into one row, newest wins", () => {
    const rows = groupConversationsByChannel([
      { id: "op-old", ts: "2026-07-18T00:00:00Z", channel_key: "dm-f-a", kind: "dm", title: "Case", preview: "old" },
      { id: "dm-f-a", ts: "2026-07-19T00:00:00Z", channel_key: "dm-f-a", kind: "dm", title: "Case", preview: "new" },
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].preview).toBe("new");
    expect(rows[0].convId).toBe("dm-f-a"); // a DM opens its canonical MERGED id
  });

  it("collapses identical-participant groups into one row, opening the newest real conversation", () => {
    const rows = groupConversationsByChannel([
      { id: "oc-1", ts: "2026-07-18T00:00:00Z", channel_key: "grp-f-a.b", kind: "group", title: "Case + Jarvis" },
      { id: "oc-2", ts: "2026-07-19T00:00:00Z", channel_key: "grp-f-a.b", kind: "group", title: "Case + Jarvis" },
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].convId).toBe("oc-2"); // grp- is display-only → open the representative conversation
  });

  it("drops feed conversations (they live only in the Feeds tab)", () => {
    const rows = groupConversationsByChannel([
      { id: "feed-x", ts: "2026-07-19T00:00:00Z", channel_key: "feed-x", kind: "feed", title: "News" },
      { id: "dm-f-a", ts: "2026-07-19T00:00:00Z", channel_key: "dm-f-a", kind: "dm", title: "Case" },
    ]);
    expect(rows.map((r) => r.channelKey)).toEqual(["dm-f-a"]);
  });
});
