import "./setup"; // sets a temp EKHO_DB_PATH before db.ts's singleton is created
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";
import { id, nowIso, addSeconds } from "../src/utils";
import {
  PRUNABLE_EVENT_TYPES,
  RETENTION_MAX_ROWS_PER_TICK,
  RETENTION_BATCH_SIZE,
  HEARTBEAT_RETENTION_DELETE_SQL
} from "../src/db";
import { config } from "../src/config";

const HOUR = 3600;
const DAY = 24 * HOUR;

// #75: events and heartbeats grew without bound. These lock in the retention
// sweep AND — more importantly — the two properties it must never lose: the
// audit trail is kept forever, and every agent always keeps a heartbeat row.
describe("Retention sweep: events and heartbeats (#75)", () => {
  let relay: TestRelay;
  let agentA: string;
  let agentB: string;

  beforeAll(async () => {
    relay = await createTestRelay();
    agentA = (await relay.enrollAgent("retention-a")).agent_id;
    agentB = (await relay.enrollAgent("retention-b")).agent_id;
  });

  // Both sweeps return global counts, so rows seeded by an earlier test (or by
  // enrollment itself) must not leak into the next.
  beforeEach(() => {
    const raw = relay.db.raw();
    raw.prepare("DELETE FROM events").run();
    raw.prepare("DELETE FROM heartbeats").run();
  });

  afterAll(() => relay.cleanup());

  function seedEvent(eventType: string, ageSeconds: number): string {
    const eventId = id("evt");
    relay.db
      .raw()
      .prepare(
        `INSERT INTO events (id, fleet_id, event_type, actor_kind, actor_id, resource_kind, resource_id, conversation_id, payload_json, created_at)
         VALUES (?, ?, ?, 'system', NULL, 'agent', NULL, NULL, '{}', ?)`
      )
      .run(eventId, relay.fleetId, eventType, addSeconds(nowIso(), -ageSeconds));
    return eventId;
  }

  function seedHeartbeat(agentId: string, ageSeconds: number): string {
    const hbId = id("hb");
    relay.db
      .raw()
      .prepare("INSERT INTO heartbeats (id, agent_id, status, metrics_json, received_at) VALUES (?, ?, 'healthy', '{}', ?)")
      .run(hbId, agentId, addSeconds(nowIso(), -ageSeconds));
    return hbId;
  }

  const eventExists = (eventId: string) =>
    !!relay.db.raw().prepare("SELECT 1 FROM events WHERE id = ?").get(eventId);
  const heartbeatIds = (agentId: string) =>
    (relay.db
      .raw()
      .prepare("SELECT id FROM heartbeats WHERE agent_id = ? ORDER BY received_at")
      .all(agentId) as Array<{ id: string }>).map((r) => r.id);

  describe("events", () => {
    test("prunes prunable-type events past the retention cutoff", () => {
      const old = seedEvent("agent.heartbeat", config.eventRetentionSeconds + DAY);
      const alsoOld = seedEvent("message.queued", config.eventRetentionSeconds + 10 * DAY);

      expect(relay.db.sweepEventRetention()).toBe(2);
      expect(eventExists(old)).toBe(false);
      expect(eventExists(alsoOld)).toBe(false);
    });

    test("never prunes audit events, however far past the cutoff they are", () => {
      // #50's operator-key audit trail is the specific thing this must not undo.
      const audit = [
        "operator_key.registered",
        "operator_key.endorsed",
        "operator_key.revoked",
        "agent_key.endorsed",
        "policy.created",
        "approval.approved",
        "agent.trust_changed",
        "agent.revoked",
        "agent.auto_quarantined",
        "agent.auto_unquarantined",
        "room.created",
        "room.deleted",
        "feed.created",
        "feed.deleted"
      ].map((type) => [type, seedEvent(type, config.eventRetentionSeconds + 365 * DAY)] as const);

      expect(relay.db.sweepEventRetention()).toBe(0);
      for (const [type, eventId] of audit) {
        expect(PRUNABLE_EVENT_TYPES.has(type)).toBe(false);
        expect(eventExists(eventId), `${type} must be retained`).toBe(true);
      }
    });

    test("never prunes events newer than the cutoff, whatever their type", () => {
      const recent = [...PRUNABLE_EVENT_TYPES].map((type) => seedEvent(type, config.eventRetentionSeconds - HOUR));

      expect(relay.db.sweepEventRetention()).toBe(0);
      for (const eventId of recent) {
        expect(eventExists(eventId)).toBe(true);
      }
    });

    test("retains an UNRECOGNISED event type past the cutoff (allowlist, not denylist)", () => {
      // The safety property: a recordEvent() call added in some future PR must
      // not start silently deleting itself once it is 30 days old.
      const futureType = "some_future.event_type_nobody_classified";
      expect(PRUNABLE_EVENT_TYPES.has(futureType)).toBe(false);
      const unknown = seedEvent(futureType, config.eventRetentionSeconds + 90 * DAY);

      expect(relay.db.sweepEventRetention()).toBe(0);
      expect(eventExists(unknown)).toBe(true);
    });

    test("prunes the aged prunable rows and leaves everything else in one pass", () => {
      const prunable = seedEvent("agent.heartbeat", config.eventRetentionSeconds + DAY);
      const audit = seedEvent("operator_key.revoked", config.eventRetentionSeconds + DAY);
      const recent = seedEvent("agent.heartbeat", HOUR);

      expect(relay.db.sweepEventRetention()).toBe(1);
      expect(eventExists(prunable)).toBe(false);
      expect(eventExists(audit)).toBe(true);
      expect(eventExists(recent)).toBe(true);
    });
  });

  describe("heartbeats", () => {
    test("keeps exactly the newest row when every row for an agent is past retention", () => {
      const oldest = seedHeartbeat(agentA, config.heartbeatRetentionSeconds + 10 * DAY);
      const middle = seedHeartbeat(agentA, config.heartbeatRetentionSeconds + 5 * DAY);
      const newest = seedHeartbeat(agentA, config.heartbeatRetentionSeconds + HOUR);

      expect(relay.db.sweepHeartbeatRetention()).toBe(2);
      // A quiet agent must never end up with zero heartbeat rows.
      expect(heartbeatIds(agentA)).toEqual([newest]);
      expect(heartbeatIds(agentA)).not.toContain(oldest);
      expect(heartbeatIds(agentA)).not.toContain(middle);
    });

    test("keeps every recent row and drops the aged ones, per agent", () => {
      // A: chatty — two recent rows plus aged history.
      const aOld1 = seedHeartbeat(agentA, config.heartbeatRetentionSeconds + 3 * DAY);
      const aOld2 = seedHeartbeat(agentA, config.heartbeatRetentionSeconds + HOUR);
      const aRecent1 = seedHeartbeat(agentA, 2 * HOUR);
      const aRecent2 = seedHeartbeat(agentA, 60);
      // B: quiet — its newest row is itself past retention and must survive.
      const bOld = seedHeartbeat(agentB, config.heartbeatRetentionSeconds + 30 * DAY);
      const bNewest = seedHeartbeat(agentB, config.heartbeatRetentionSeconds + 2 * DAY);

      expect(relay.db.sweepHeartbeatRetention()).toBe(3); // aOld1, aOld2, bOld

      const a = heartbeatIds(agentA);
      expect(a).toEqual([aRecent1, aRecent2]);
      expect(a).not.toContain(aOld1);
      expect(a).not.toContain(aOld2);
      expect(heartbeatIds(agentB)).toEqual([bNewest]);
      expect(heartbeatIds(agentB)).not.toContain(bOld);
    });

    test("breaks an exact received_at tie by insertion order, keeping the later row", () => {
      // Two rows for one agent with the SAME timestamp — reachable whenever
      // heartbeats land faster than the clock's resolution, or via a backfill
      // that stamps a batch identically. "Newest" is then decided by rowid, so
      // the later-inserted row is the one that must survive. Pinned explicitly
      // because it is the only case where the keep-newest predicate's tiebreak
      // is load-bearing, and any reformulation of it must preserve this.
      const sameInstant = addSeconds(nowIso(), -(config.heartbeatRetentionSeconds + DAY));
      const insert = relay.db
        .raw()
        .prepare("INSERT INTO heartbeats (id, agent_id, status, metrics_json, received_at) VALUES (?, ?, 'healthy', '{}', ?)");
      const first = id("hb");
      const second = id("hb");
      insert.run(first, agentA, sameInstant);
      insert.run(second, agentA, sameInstant); // later rowid = newest

      expect(relay.db.sweepHeartbeatRetention()).toBe(1);
      expect(heartbeatIds(agentA)).toEqual([second]);
    });

    test("is a no-op when nothing is past retention", () => {
      seedHeartbeat(agentA, HOUR);
      seedHeartbeat(agentB, 2 * HOUR);

      expect(relay.db.sweepHeartbeatRetention()).toBe(0);
      expect(heartbeatIds(agentA).length + heartbeatIds(agentB).length).toBe(2);
    });
  });

  // The heartbeat sweep's keep-newest predicate runs a correlated subquery once
  // per candidate row, so its cost is decided entirely by the plan SQLite picks
  // for that subquery. These guard the plan rather than a millisecond budget:
  // wall-clock assertions flake on shared CI, but a plan that stops being an
  // index seek is the regression itself, and it is exactly observable.
  describe("heartbeat sweep cost", () => {
    test("the keep-newest subquery is an index seek, not a per-row sort", () => {
      const plan = (relay.db
        .raw()
        .prepare("EXPLAIN QUERY PLAN " + HEARTBEAT_RETENTION_DELETE_SQL)
        .all(nowIso(), RETENTION_BATCH_SIZE) as Array<{ detail: string }>).map((r) => r.detail);

      // Dropping idx_heartbeats_agent_recency turns the subquery into a scan
      // plus a sort of the agent's whole row-group, PER CANDIDATE ROW — ~62s
      // per 5,000-row batch at a few million rows, which would block the event
      // loop for minutes per tick while a backlog drains.
      expect(plan.join("\n")).not.toMatch(/TEMP B-TREE/);
      expect(plan.some((step) => /SEARCH h2 .*idx_heartbeats_agent_recency/.test(step)), plan.join("\n")).toBe(true);
      // And the outer candidate scan must use the age index from migration 022.
      expect(plan.some((step) => /SEARCH h .*idx_heartbeats_received_at/.test(step)), plan.join("\n")).toBe(true);
    });

    test("drains a full tick's worth of backlog across many agents", () => {
      // Not a timing assertion — a smoke test that the sweep still terminates
      // on a dataset with the shape that motivated #75 (a long history spread
      // over many agents), which a scan-heavy plan would not do in any
      // reasonable time.
      const AGENTS = 200;
      const PER_AGENT = 250; // 50,000 rows = exactly one tick's cap
      const raw = relay.db.raw();
      const insertAgent = raw.prepare(
        `INSERT INTO agents (id, fleet_id, display_name, runtime, status, policy_profile, created_at)
         VALUES (?, ?, ?, 'test', 'active', 'default', ?)`
      );
      const insertHeartbeat = raw.prepare(
        "INSERT INTO heartbeats (id, agent_id, status, metrics_json, received_at) VALUES (?, ?, 'healthy', '{}', ?)"
      );
      const now = nowIso();
      const agentIds: string[] = [];
      raw.transaction(() => {
        for (let a = 0; a < AGENTS; a += 1) {
          const agentId = id("agt");
          agentIds.push(agentId);
          insertAgent.run(agentId, relay.fleetId, `bulk-${a}`, now);
          for (let i = 0; i < PER_AGENT; i += 1) {
            // Every row past retention, so each agent keeps exactly its newest.
            insertHeartbeat.run(id("hb"), agentId, addSeconds(now, -(config.heartbeatRetentionSeconds + (PER_AGENT - i) * HOUR)));
          }
        }
      })();

      const expected = AGENTS * (PER_AGENT - 1); // one survivor per agent
      expect(relay.db.sweepHeartbeatRetention()).toBe(expected);
      const remaining = raw.prepare("SELECT COUNT(*) AS c FROM heartbeats").get() as { c: number };
      expect(remaining.c).toBe(AGENTS);
      for (const agentId of agentIds) expect(heartbeatIds(agentId).length).toBe(1);

      raw.prepare("DELETE FROM heartbeats").run();
      raw.prepare(`DELETE FROM agents WHERE display_name LIKE 'bulk-%'`).run();
    });
  });

  describe("batching", () => {
    test("one tick deletes at most the per-tick cap; the remainder drains on the next", () => {
      // Proves a months-old backlog can't wedge a single sweep tick, without
      // seeding millions of rows: cap + overflow is enough to hit the ceiling.
      const overflow = 25;
      const total = RETENTION_MAX_ROWS_PER_TICK + overflow;
      const raw = relay.db.raw();
      const insert = raw.prepare(
        `INSERT INTO events (id, fleet_id, event_type, actor_kind, actor_id, resource_kind, resource_id, conversation_id, payload_json, created_at)
         VALUES (?, ?, 'agent.heartbeat', 'system', NULL, 'agent', NULL, NULL, '{}', ?)`
      );
      const stale = addSeconds(nowIso(), -(config.eventRetentionSeconds + DAY));
      raw.transaction(() => {
        for (let i = 0; i < total; i += 1) insert.run(id("evt"), relay.fleetId, stale);
      })();
      // One audit row of the same age, to prove the cap doesn't sweep it in.
      const audit = seedEvent("operator_key.revoked", config.eventRetentionSeconds + DAY);

      expect(relay.db.sweepEventRetention()).toBe(RETENTION_MAX_ROWS_PER_TICK);
      expect(relay.db.sweepEventRetention()).toBe(overflow);
      expect(relay.db.sweepEventRetention()).toBe(0);
      expect(eventExists(audit)).toBe(true);
    });

    test("the per-tick cap is batch size x max batches", () => {
      expect(RETENTION_MAX_ROWS_PER_TICK).toBe(RETENTION_BATCH_SIZE * 10);
    });
  });
});
