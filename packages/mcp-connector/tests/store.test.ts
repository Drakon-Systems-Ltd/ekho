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
  it("is bounded: delivered and outbound messages fall off past the cap, oldest first", () => {
    const s = new MessageStore(tmpDir(), 3);
    s.add([msg("1"), msg("2")]);
    const read = s.takeUnread(10);
    s.takeUnread(10, read.cursor); // confirm 1 and 2
    s.add([msg("o", { direction: "out", delivered_cursor: "self" }), msg("3"), msg("4")]);
    expect(s.size()).toBe(3);
    expect(s.takeUnread(10).messages.map((m) => m.message_id)).toEqual(["3", "4"]);
  });

  it("never evicts an unread message: the ring overflows and reports no room instead", () => {
    const s = new MessageStore(tmpDir(), 3);
    s.add([msg("1"), msg("2"), msg("3"), msg("4"), msg("5")]);
    expect(s.size()).toBe(5);
    expect(s.hasRoom()).toBe(false);
    expect(s.takeUnread(10).messages.map((m) => m.message_id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("has room again once the client confirms a batch", () => {
    const s = new MessageStore(tmpDir(), 2);
    s.add([msg("1"), msg("2")]);
    expect(s.hasRoom()).toBe(false);
    const read = s.takeUnread(10);
    expect(s.hasRoom()).toBe(false); // handed out, not yet confirmed
    s.confirm(read.cursor);
    expect(s.hasRoom()).toBe(true);
    expect(s.unreadCount()).toBe(0);
  });

  it("survives a restart, including read state and replay guards", () => {
    const dir = tmpDir();
    const a = new MessageStore(dir, 50);
    a.add([msg("1"), msg("2")]);
    const { cursor } = a.takeUnread(1);
    a.confirm(cursor);
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

  it("a retry with the same cursor returns the same batch; a read after it moves on", () => {
    const s = new MessageStore(tmpDir(), 50);
    s.add([msg("1"), msg("2"), msg("3")]);
    const first = s.takeUnread(2);
    expect(first.messages.map((m) => m.message_id)).toEqual(["1", "2"]);
    expect(s.replay(first.cursor)?.map((m) => m.message_id)).toEqual(["1", "2"]);
    const second = s.takeUnread(2, first.cursor);
    expect(second.messages.map((m) => m.message_id)).toEqual(["3"]);
    expect(s.replay("cur_unknown")).toBeNull();
  });

  it("a lost response loses nothing: a plain read repeats the unconfirmed batch, then newer messages", () => {
    const s = new MessageStore(tmpDir(), 50);
    s.add([msg("1"), msg("2")]);
    const first = s.takeUnread(10); // response never reached the client
    s.add([msg("3")]);
    const retry = s.takeUnread(10);
    expect(retry.messages.map((m) => m.message_id)).toEqual(["1", "2", "3"]);
    expect(retry.cursor).not.toBe(first.cursor);
    // The old cursor still replays its exact batch; confirming the new one reads all three.
    expect(s.replay(first.cursor)?.map((m) => m.message_id)).toEqual(["1", "2"]);
    expect(s.takeUnread(10, retry.cursor).messages).toEqual([]);
    expect(s.unreadCount()).toBe(0);
  });

  it("a stale `after` never resurfaces a confirmed batch through a newer unconfirmed cursor", () => {
    const s = new MessageStore(tmpDir(), 50);
    s.add([msg("1"), msg("2")]);
    const c1 = s.takeUnread(10); // (1,2)
    s.add([msg("3")]);
    const c2 = s.takeUnread(10); // (1,2,3), never confirmed
    expect(c2.messages.map((m) => m.message_id)).toEqual(["1", "2", "3"]);
    // The client confirms the older batch; 1 and 2 are read, 3 is still due.
    const next = s.takeUnread(10, c1.cursor);
    expect(next.messages.map((m) => m.message_id)).toEqual(["3"]);
    expect(s.unreadCount()).toBe(1);
    // Repeating the same stale `after` does not bring 1 and 2 back either.
    for (let i = 0; i < 3; i++) expect(s.takeUnread(10, c1.cursor).messages.map((m) => m.message_id)).toEqual(["3"]);
    // Old cursors still replay exactly, and 3 is read once its batch is confirmed.
    expect(s.replay(c2.cursor)?.map((m) => m.message_id)).toEqual(["1", "2", "3"]);
    expect(s.takeUnread(10, next.cursor).messages).toEqual([]);
    expect(s.unreadCount()).toBe(0);
  });

  it("cursor copies are deep: mutating a returned or replayed message leaves later replays intact", () => {
    const s = new MessageStore(tmpDir(), 50);
    s.add([msg("1", { mentions: ["a"], attachments: [{ id: "att", filename: "f.txt", mime: "text/plain", size_bytes: 1 }] })]);
    const { cursor, messages } = s.takeUnread(10);
    messages[0].mentions.push("x");
    messages[0].attachments[0].filename = "changed";
    s.replay(cursor)![0].mentions.push("y");
    const again = s.replay(cursor)![0];
    expect(again.mentions).toEqual(["a"]);
    expect(again.attachments[0].filename).toBe("f.txt");
  });

  it("an outbound message added while the unread queue is full stays in the conversation history", () => {
    const s = new MessageStore(tmpDir(), 2);
    s.add([msg("1"), msg("2")]);
    expect(s.hasRoom()).toBe(false);
    s.add([msg("o", { direction: "out", delivered_cursor: "self" })]);
    expect(s.conversation("conv", 10).map((m) => m.message_id)).toEqual(["1", "2", "o"]);
    // The next mutation takes the ring back towards its bound.
    s.add([msg("o2", { direction: "out", delivered_cursor: "self" })]);
    expect(s.conversation("conv", 10).map((m) => m.message_id)).toEqual(["1", "2", "o2"]);
  });

  it("replay is exact after the batch's messages were evicted", () => {
    const s = new MessageStore(tmpDir(), 2);
    s.add([msg("1"), msg("2")]);
    const first = s.takeUnread(10);
    s.takeUnread(10, first.cursor);
    s.add([msg("3"), msg("4")]); // evicts 1 and 2, both read
    expect(s.conversation("conv", 10).map((m) => m.message_id)).toEqual(["3", "4"]);
    expect(s.replay(first.cursor)?.map((m) => m.message_id)).toEqual(["1", "2"]);
  });

  it("confirming an unknown cursor is a no-op", () => {
    const s = new MessageStore(tmpDir(), 50);
    s.add([msg("1")]);
    s.confirm("cur_nope");
    expect(s.unreadCount()).toBe(1);
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
