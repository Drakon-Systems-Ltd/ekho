import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// Infinite scroll-back pages older events via a compound keyset cursor
// (before_at, before_id). It must be gap-free and duplicate-free even when many
// events share the same millisecond — the exact failure mode a plain created_at
// cursor has at a page boundary.
describe("conversation keyset pagination", () => {
  let relay: TestRelay;
  let convId: string;

  let evtId: (i: number) => string;

  beforeEach(async () => {
    relay = await createTestRelay();
    // The test DB is shared across cases; namespace ids by fleet so re-seeds
    // never collide on the events PK.
    const tag = relay.fleetId.slice(-8);
    convId = `keyset-conv-${tag}`;
    evtId = (i) => `evt-${tag}-${String(i).padStart(3, "0")}`;
    const insert = relay.db.raw().prepare(
      `INSERT INTO events (id, fleet_id, event_type, actor_kind, actor_id, resource_kind, resource_id, conversation_id, payload_json, created_at)
       VALUES (?, ?, 'message.queued', 'agent', 'a1', 'message', ?, ?, '{}', ?)`
    );
    // 25 events; events 10..14 deliberately share ONE millisecond to stress the
    // tie boundary. ids are zero-padded so id ordering is deterministic.
    for (let i = 0; i < 25; i++) {
      const id = evtId(i);
      const ms = i >= 10 && i <= 14 ? "2026-07-18T12:00:10.000Z" : `2026-07-18T12:00:${String(i).padStart(2, "0")}.500Z`;
      insert.run(id, relay.fleetId, id, convId, ms);
    }
  });

  it("pages the whole conversation with no gaps or duplicates, ties included", async () => {
    const seen: string[] = [];
    let before: { at: string; id: string } | null = null;
    const LIMIT = 7;
    for (let guard = 0; guard < 20; guard++) {
      const qs = new URLSearchParams({ sortOrder: "desc", limit: String(LIMIT) });
      if (before) { qs.set("before_at", before.at); qs.set("before_id", before.id); }
      const res = await relay.operatorRequest("GET", `/v1/operator/conversations/${convId}?${qs.toString()}`);
      const events = res.body.events as Array<{ id: string; created_at: string }>;
      if (!events.length) break;
      // Rows come newest-first; the oldest of this page is the next cursor.
      for (const e of events) seen.push(e.id);
      const oldest = events[events.length - 1];
      before = { at: oldest.created_at, id: oldest.id };
    }
    const unique = new Set(seen);
    expect(unique.size).toBe(25);          // every event surfaced
    expect(seen.length).toBe(25);          // …exactly once (no duplicates)
    // The five tie events are all present.
    for (let i = 10; i <= 14; i++) expect(unique.has(evtId(i))).toBe(true);
  });

  it("returns strictly-older events for a cursor and never the cursor row itself", async () => {
    const first = await relay.operatorRequest("GET", `/v1/operator/conversations/${convId}?sortOrder=desc&limit=5`);
    const firstEvents = first.body.events as Array<{ id: string; created_at: string }>;
    const cursor = firstEvents[firstEvents.length - 1];

    const older = await relay.operatorRequest(
      "GET",
      `/v1/operator/conversations/${convId}?sortOrder=desc&limit=5&before_at=${encodeURIComponent(cursor.created_at)}&before_id=${cursor.id}`
    );
    const olderIds = (older.body.events as Array<{ id: string }>).map((e) => e.id);
    expect(olderIds).not.toContain(cursor.id);
    const firstIds = new Set(firstEvents.map((e) => e.id));
    for (const id of olderIds) expect(firstIds.has(id)).toBe(false); // no overlap with the newer page
  });
});
