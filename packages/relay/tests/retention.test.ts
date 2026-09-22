import "./setup"; // sets a temp EKHO_DB_PATH before db.ts's singleton is created
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";
import { id, nowIso, addSeconds } from "../src/utils";
import { PRUNABLE_EVENT_TYPES, RETENTION_MAX_ROWS_PER_TICK, RETENTION_BATCH_SIZE } from "../src/db";
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

    test("is a no-op when nothing is past retention", () => {
      seedHeartbeat(agentA, HOUR);
      seedHeartbeat(agentB, 2 * HOUR);

      expect(relay.db.sweepHeartbeatRetention()).toBe(0);
      expect(heartbeatIds(agentA).length + heartbeatIds(agentB).length).toBe(2);
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
