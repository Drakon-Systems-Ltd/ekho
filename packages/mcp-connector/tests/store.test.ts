import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MessageStore, QUEUE_FILE, SEEN_CAP, type StoredMessage } from "../src/store";
import { tmpDir } from "./helpers";

function msg(id: string, extra: Partial<StoredMessage> = {}): StoredMessage {
  return {
    message_id: id,
    conversation_id: "conv",
    direction: "in",
    sender_agent_id: "agent_x",
    sender_label: "X",
    sender_kind: "agent",
    message_type: "direct",
    priority: "normal",
    text: `text ${id}`,
    attachments: [],
    mentions: [],
    reply_to: null,
    room: null,
    verification: { status: "verified", reason: null, key_id: "k" },
    sent_at: "2026-10-07T00:00:00.000Z",
    stored_at: "2026-10-07T00:00:00.000Z",
    delivered_cursor: null,
    ...extra
  };
}

describe("MessageStore", () => {
  it("is bounded: the oldest messages fall off past the cap", () => {
    const s = new MessageStore(tmpDir(), 3);
    s.add([msg("1"), msg("2"), msg("3"), msg("4")]);
    expect(s.size()).toBe(3);
    expect(s.takeUnread(10).messages.map((m) => m.message_id)).toEqual(["2", "3", "4"]);
  });

  it("survives a restart, including read state and replay guards", () => {
    const dir = tmpDir();
    const a = new MessageStore(dir, 50);
    a.add([msg("1"), msg("2")]);
    const { cursor } = a.takeUnread(1);
    a.markNonceSeen("n1");
    a.flush();
    const b = new MessageStore(dir, 50);
    expect(b.unreadCount()).toBe(1);
    expect(b.replay(cursor)?.map((m) => m.message_id)).toEqual(["1"]);
    expect(b.nonceSeen("n1")).toBe(true);
    expect(b.messageSeen("2")).toBe(true);
  });

  it("writes atomically: no temp files are left beside the queue", () => {
    const dir = tmpDir();
    const s = new MessageStore(dir, 50);
    s.add([msg("1")]);
    const files = fs.readdirSync(dir);
    expect(files).toEqual([QUEUE_FILE]);
    expect(fs.statSync(path.join(dir, QUEUE_FILE)).mode & 0o777).toBe(0o600);
  });

  it("a retry with the same cursor returns the same batch; a fresh read moves on", () => {
    const s = new MessageStore(tmpDir(), 50);
    s.add([msg("1"), msg("2"), msg("3")]);
    const first = s.takeUnread(2);
    expect(first.messages.map((m) => m.message_id)).toEqual(["1", "2"]);
    expect(s.replay(first.cursor)?.map((m) => m.message_id)).toEqual(["1", "2"]);
    const second = s.takeUnread(2);
    expect(second.messages.map((m) => m.message_id)).toEqual(["3"]);
    expect(s.replay("cur_unknown")).toBeNull();
  });

  it("caps the seen-nonce FIFO like the plugin", () => {
    const s = new MessageStore(tmpDir(), 50);
    for (let i = 0; i < SEEN_CAP + 10; i++) s.markNonceSeen(`n${i}`);
    expect(s.nonceSeen("n0")).toBe(false);
    expect(s.nonceSeen(`n${SEEN_CAP + 9}`)).toBe(true);
  });

  it("conversation view is both directions, oldest first, last N", () => {
    const s = new MessageStore(tmpDir(), 50);
    s.add([msg("1"), msg("o", { direction: "out", delivered_cursor: "self" }), msg("2"), msg("z", { conversation_id: "other" })]);
    expect(s.conversation("conv", 2).map((m) => m.message_id)).toEqual(["o", "2"]);
  });
});
