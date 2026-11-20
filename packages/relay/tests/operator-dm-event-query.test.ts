import { createTestRelay, type TestRelay } from "./setup"; // sets a temp EKHO_DB_PATH before db.ts's singleton is created
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

// #196 — the operator console's canonical DM view (GET
// /v1/operator/conversations/dm-<fleet>-<agent>) used to read `events` with
//
//   WHERE fleet_id = ? AND (resource_id IN (SELECT id FROM messages …) OR conversation_id = ?)
//
// and `events` had no index on resource_id or conversation_id, so SQLite walked
// idx_events_fleet_created_at: every event the fleet has ever recorded, once
// for the page and once more for the COUNT. better-sqlite3 is synchronous, so
// on a large fleet one polling console tab held the event loop long enough
// that the relay stopped accepting connections.
//
// These guard the PLAN rather than a millisecond budget (same reasoning as the
// heartbeat-sweep plan test in retention.test.ts): wall-clock assertions flake
// on shared CI, while "the DM read walks the whole fleet" is the regression
// itself and is exactly observable. The plan must hold with NO planner
// statistics at all, because a fresh or never-ANALYZEd database has none.

type Row = Record<string, unknown>;
type Captured = { sql: string; params: unknown[] };

const EVENT_ID_COLUMNS = "id, event_type, actor_kind, actor_id, resource_kind, resource_id, payload_json, created_at";

// The pre-#196 predicate, kept verbatim as the reference the rewritten query
// must stay row-for-row equivalent to.
const REFERENCE_DM_WHERE =
  "fleet_id = ? AND (resource_id IN (SELECT id FROM messages WHERE fleet_id = ? AND recipient_kind = 'agent' AND ((sender_agent_id = ? AND recipient_id = ?) OR (sender_agent_id = ? AND recipient_id = ?))) OR conversation_id = ?)";

describe("operator DM conversation event query (#196)", () => {
  let relay: TestRelay;
  let other: TestRelay;
  let agentX: string;
  let agentY: string;
  let dm: string;
  let opId: string;
  let tag: string;

  /** Run fn and return every statement it prepared that reads `events`, with the values it bound. */
  function captureEventReads(fn: () => void): Captured[] {
    const raw = relay.db.raw();
    const realPrepare = raw.prepare.bind(raw);
    const seen: Captured[] = [];
    const spy = vi.spyOn(raw, "prepare").mockImplementation(((sql: string) => {
      const stmt = realPrepare(sql);
      if (!/\bevents\b/.test(sql)) return stmt;
      return new Proxy(stmt, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === "all" || prop === "get") {
            return (...params: unknown[]) => {
              seen.push({ sql, params });
              return (value as (...a: unknown[]) => unknown).apply(target, params);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }) as never);
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return seen;
  }

  function planOf(q: Captured): string[] {
    return (relay.db.raw().prepare("EXPLAIN QUERY PLAN " + q.sql).all(...q.params) as Array<{ detail: string }>).map((r) => r.detail);
  }

  /** Every plan step that touches the events table (under any alias). */
  function eventSteps(plan: string[]): string[] {
    return plan.filter((step) => /^(SCAN|SEARCH) (events|ev)\b/.test(step));
  }

  function expectBoundedDmPlans(label: string) {
    const reads = captureEventReads(() => {
      relay.db.getConversation(relay.fleetId, dm, { sortOrder: "desc", limit: 50, offset: 0 });
    });
    // The page read and the COUNT that follows it: both must be bounded.
    expect(reads.length, label).toBe(2);
    for (const q of reads) {
      const plan = planOf(q);
      const text = `${label}\n${q.sql}\n${plan.join("\n")}`;
      const steps = eventSteps(plan);
      expect(steps.length, text).toBeGreaterThan(0);
      // The outage: walking the whole fleet's events.
      expect(plan.join("\n"), text).not.toMatch(/idx_events_fleet_created_at/);
      // No full table scan of events, and nothing left to a transient index.
      expect(plan.join("\n"), text).not.toMatch(/SCAN (events|ev)\b/);
      expect(plan.join("\n"), text).not.toMatch(/AUTOMATIC/);
      // Every events access is a seek: on one of the two indexes migration 029
      // adds, or a fetch of one row by rowid.
      for (const step of steps) {
        expect(step, text).toMatch(/USING ((COVERING )?INDEX (idx_events_resource|idx_events_fleet_conversation) |INTEGER PRIMARY KEY \(rowid=\?\))/);
      }
      expect(steps.some((s) => /^SEARCH events USING INTEGER PRIMARY KEY \(rowid=\?\)/.test(s)), text).toBe(true);
      expect(steps.some((s) => /idx_events_resource \(resource_id=\?\)/.test(s)), text).toBe(true);
      expect(steps.some((s) => /idx_events_fleet_conversation \(fleet_id=\? AND conversation_id=\?/.test(s)), text).toBe(true);
    }
  }

  function referenceDm(order: "ASC" | "DESC", limit: number, offset: number) {
    const raw = relay.db.raw();
    const params = [relay.fleetId, relay.fleetId, opId, agentX, agentX, opId, dm];
    const rows = raw.prepare(
      `SELECT ${EVENT_ID_COLUMNS} FROM events WHERE ${REFERENCE_DM_WHERE} ORDER BY created_at ${order}, id ${order} LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Row[];
    const total = (raw.prepare(`SELECT COUNT(*) AS count FROM events WHERE ${REFERENCE_DM_WHERE}`).get(...params) as { count: number }).count;
    return { ids: rows.map((r) => String(r.id)), total };
  }

  beforeAll(async () => {
    relay = await createTestRelay();
    other = await createTestRelay(); // a second fleet in the same database
    agentX = (await relay.enrollAgent("Case")).agent_id;
    agentY = (await relay.enrollAgent("Molly")).agent_id;
    dm = `dm-${relay.fleetId}-${agentX}`;
    opId = `op_${relay.fleetId}`;
    tag = relay.fleetId.slice(-8);
    const raw = relay.db.raw();

    // Real writes through the relay's own paths.
    relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: agentX, text: "op-canonical" });
    relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: agentX, conversationId: "op-legacy-1", text: "op-legacy" });
    relay.db.createMessage({ fleetId: relay.fleetId, senderAgentId: agentX, recipientKind: "agent", recipientId: opId, messageType: "direct", priority: "normal", ttlSeconds: 900, requiresApproval: false, body: { text: "agent-back" }, conversationId: "oc-1", correlationId: "c1" });
    // A legacy thread that ALSO carries operator↔Y traffic: must never bleed in.
    relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: agentX, conversationId: "mixed-1", text: "to-X-mixed" });
    relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: agentY, conversationId: "mixed-1", text: "to-Y-mixed" });
    // X talking to Y is not part of the operator↔X DM.
    relay.db.createMessage({ fleetId: relay.fleetId, senderAgentId: agentX, recipientKind: "agent", recipientId: agentY, messageType: "direct", priority: "normal", ttlSeconds: 900, requiresApproval: false, body: { text: "x-to-y" }, conversationId: "peer-1", correlationId: "c2" });

    const insertEvent = raw.prepare(
      `INSERT INTO events (id, fleet_id, event_type, actor_kind, actor_id, resource_kind, resource_id, conversation_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const xMessageIds = (raw.prepare(
      `SELECT id FROM messages WHERE fleet_id = ? AND recipient_kind = 'agent'
         AND ((sender_agent_id = ? AND recipient_id = ?) OR (sender_agent_id = ? AND recipient_id = ?)) ORDER BY id`
    ).all(relay.fleetId, opId, agentX, agentX, opId) as Array<{ id: string }>).map((r) => r.id);
    expect(xMessageIds.length).toBe(4);

    raw.transaction(() => {
      // Several lifecycle events per DM message, some sharing one millisecond,
      // some threaded under the canonical id (so BOTH branches match them and
      // they must still be returned and counted exactly once).
      let n = 0;
      for (const mid of xMessageIds) {
        for (const type of ["message.delivered", "message.acked"]) {
          const i = n++;
          const at = i < 4 ? "2026-11-01T10:00:00.000Z" : `2026-11-01T10:00:${String(i).padStart(2, "0")}.000Z`;
          insertEvent.run(`evt-${tag}-life-${String(i).padStart(3, "0")}`, relay.fleetId, type, "agent", agentX, "message", mid, i % 2 ? dm : `legacy-${i}`, `{"n":${i}}`, at);
        }
      }
      // Conversation-level events under the canonical id, with no message.
      insertEvent.run(`evt-${tag}-stall`, relay.fleetId, "conversation.stalled", "system", agentX, "conversation", dm, dm, '{"why":"needle-stall"}', "2026-11-01T10:30:00.000Z");
      insertEvent.run(`evt-${tag}-resume`, relay.fleetId, "conversation.resumed", "operator", relay.operatorId, "conversation", null, dm, "{}", "2026-11-01T10:31:00.000Z");

      // ANOTHER fleet's events that point at this fleet's DM message and at
      // this fleet's canonical id. The fleet filter must keep both out.
      insertEvent.run(`evt-${tag}-foreign-res`, other.fleetId, "message.acked", "agent", "x", "message", xMessageIds[0], "elsewhere", "{}", "2026-11-01T10:40:00.000Z");
      insertEvent.run(`evt-${tag}-foreign-conv`, other.fleetId, "conversation.stalled", "system", "x", "conversation", dm, dm, "{}", "2026-11-01T10:41:00.000Z");

      // The shape that made the old query expensive: a fleet whose events are
      // overwhelmingly NOT this DM (no conversation, or other conversations).
      for (let i = 0; i < 4000; i++) {
        const at = new Date(Date.parse("2026-10-01T00:00:00.000Z") + i * 1000).toISOString();
        if (i % 10 < 7) insertEvent.run(`evt-${tag}-fill-${i}`, relay.fleetId, "agent.status", "agent", agentY, "agent", agentY, null, "{}", at);
        else insertEvent.run(`evt-${tag}-fill-${i}`, relay.fleetId, "message.queued", "agent", agentY, "message", `msg-nope-${i}`, `conv-${i % 40}`, "{}", at);
      }
    })();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the DM through index seeks only, with no planner statistics", () => {
    const raw = relay.db.raw();
    const stats = raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'").get() as { n: number };
    expect(stats.n).toBe(0); // precondition: this really is the no-stats case
    expectBoundedDmPlans("no statistics");
  });

  it("keeps the same bounded plan once ANALYZE has run on a skewed table", () => {
    const raw = relay.db.raw();
    raw.exec("ANALYZE");
    try {
      expectBoundedDmPlans("after ANALYZE");
    } finally {
      raw.exec("DROP TABLE IF EXISTS sqlite_stat1");
    }
  });

  it("reads an ordinary conversation through idx_events_fleet_conversation", () => {
    const reads = captureEventReads(() => {
      relay.db.getConversation(relay.fleetId, "conv-3", { sortOrder: "desc", limit: 50, offset: 0 });
    });
    expect(reads.length).toBe(2);
    for (const q of reads) {
      const plan = planOf(q);
      const text = `${q.sql}\n${plan.join("\n")}`;
      expect(plan.join("\n"), text).not.toMatch(/idx_events_fleet_created_at/);
      expect(plan.some((s) => /SEARCH events USING (COVERING )?INDEX idx_events_fleet_conversation \(fleet_id=\? AND conversation_id=\?/.test(s)), text).toBe(true);
    }
  });

  it("returns exactly the rows and total the pre-#196 predicate returned", () => {
    for (const order of ["ASC", "DESC"] as const) {
      for (const [limit, offset] of [[100, 0], [3, 0], [3, 3], [5, 7]] as const) {
        const ref = referenceDm(order, limit, offset);
        const got = relay.db.getConversation(relay.fleetId, dm, { sortOrder: order.toLowerCase(), limit, offset });
        expect((got.items as Row[]).map((r) => String(r.id)), `${order} ${limit}/${offset}`).toEqual(ref.ids);
        expect(got.total, `${order} ${limit}/${offset}`).toBe(ref.total);
      }
    }
  });

  it("merges the scattered 1:1 history once each, and leaks neither another agent nor another fleet", () => {
    const got = relay.db.getConversation(relay.fleetId, dm, { sortOrder: "asc", limit: 500, offset: 0 });
    const items = got.items as Row[];
    const ids = items.map((r) => String(r.id));
    expect(new Set(ids).size).toBe(ids.length); // a row both branches match is returned once
    expect(got.total).toBe(ids.length);         // …and counted once

    const texts = items.map((r) => {
      try { return String((JSON.parse(String(r.message_body_json ?? "{}")) as { text?: string }).text ?? ""); } catch { return ""; }
    });
    for (const want of ["op-canonical", "op-legacy", "agent-back", "to-X-mixed"]) expect(texts).toContain(want);
    expect(texts).not.toContain("to-Y-mixed");
    expect(texts).not.toContain("x-to-y");

    for (let i = 0; i < 8; i++) expect(ids).toContain(`evt-${tag}-life-${String(i).padStart(3, "0")}`);
    expect(ids).toContain(`evt-${tag}-stall`);
    expect(ids).toContain(`evt-${tag}-resume`);
    expect(ids).not.toContain(`evt-${tag}-foreign-res`);
    expect(ids).not.toContain(`evt-${tag}-foreign-conv`);
    expect(ids.some((id) => id.includes("-fill-"))).toBe(false);
  });

  it("applies type, date, search and keyset filters on top of the merge", () => {
    const all = relay.db.getConversation(relay.fleetId, dm, { sortOrder: "desc", limit: 500, offset: 0 });
    const allItems = all.items as Row[];

    const typed = relay.db.getConversation(relay.fleetId, dm, { type: "conversation", sortOrder: "asc", limit: 500, offset: 0 });
    expect((typed.items as Row[]).map((r) => String(r.id))).toEqual([`evt-${tag}-stall`, `evt-${tag}-resume`]);
    expect(typed.total).toBe(2);

    const searched = relay.db.getConversation(relay.fleetId, dm, { search: "needle-stall", limit: 500, offset: 0 });
    expect((searched.items as Row[]).map((r) => String(r.id))).toEqual([`evt-${tag}-stall`]);
    expect(searched.total).toBe(1);

    const dated = relay.db.getConversation(relay.fleetId, dm, { dateFrom: "2026-11-01", dateTo: "2026-11-01", sortBy: "event_type", sortOrder: "asc", limit: 500, offset: 0 });
    const datedIds = (dated.items as Row[]).map((r) => String(r.id));
    const expectDated = allItems.filter((r) => String(r.created_at).startsWith("2026-11-01")).map((r) => String(r.id));
    expect(expectDated.length).toBe(10);
    expect([...datedIds].sort()).toEqual([...expectDated].sort());
    expect(dated.total).toBe(10);

    // Keyset scroll-back across the four events sharing one millisecond:
    // gap-free and duplicate-free, exactly as for a single conversation.
    const seen: string[] = [];
    let before: { at: string; id: string } | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page = relay.db.getConversation(relay.fleetId, dm, {
        sortOrder: "desc", limit: 3, offset: 0, beforeAt: before?.at, beforeId: before?.id
      }).items as Row[];
      if (!page.length) break;
      for (const r of page) seen.push(String(r.id));
      const oldest = page[page.length - 1];
      before = { at: String(oldest.created_at), id: String(oldest.id) };
    }
    expect(seen).toEqual(allItems.map((r) => String(r.id)));
  });

  it("serves the merged DM over the operator route", async () => {
    const res = await relay.operatorRequest("GET", `/v1/operator/conversations/${dm}?sortOrder=desc&limit=5`);
    expect(res.status).toBe(200);
    const ref = referenceDm("DESC", 5, 0);
    expect((res.body.events as Array<{ id: string }>).map((e) => e.id)).toEqual(ref.ids);
    expect(res.body.total).toBe(ref.total);
  });
});
