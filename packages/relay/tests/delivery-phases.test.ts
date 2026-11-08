import "./setup"; // sets a temp EKHO_DB_PATH before db.ts's singleton is created
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { createTestRelay, type TestRelay } from "./setup";
import { runMigrationsOn } from "../src/db";
import { schemaSql } from "../src/schema";

const REAL_MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

/**
 * #155 Phase 1a — relay-observed delivery timing (design §2.2).
 *
 * Two relay-clock fields that need no adapter cooperation and carry no content:
 *
 *   agents.last_inbox_poll_at          relay time of the agent's most recent
 *                                      GET /v1/inbox, written even when the
 *                                      batch is empty. The one signal that tells
 *                                      "the adapter stopped polling" apart from
 *                                      "the adapter is mid-turn" at the relay.
 *   message_deliveries.ack_recorded_at relay time the ack ARRIVED. acked_at is
 *                                      still the adapter-supplied received_at
 *                                      (adapter clock) and keeps its meaning.
 *
 * Everything here is ids and timestamps. No body, prompt, key or path is ever
 * written or returned.
 */
describe("#155 phase 1a: relay-observed delivery timing", () => {
  let relay: TestRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(() => {
    relay.cleanup();
  });

  const isoWithin = (iso: string, lo: number, hi: number) => {
    const t = Date.parse(iso);
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeGreaterThanOrEqual(lo);
    expect(t).toBeLessThanOrEqual(hi);
  };

  describe("agents.last_inbox_poll_at", () => {
    it("is null until the agent polls, is stamped by an EMPTY inbox poll, and advances on the next poll", async () => {
      const a = await relay.enrollAgent("dp-poll-a");

      let health = await relay.operatorRequest("GET", "/v1/operator/fleet-health");
      let row = health.body.agents.find((x: { id: string }) => x.id === a.agent_id);
      expect(row).toBeDefined();
      expect(row.last_inbox_poll_at).toBeNull();

      const before = Date.now();
      const inbox = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
      expect(inbox.status).toBe(200);
      expect(inbox.body.messages).toEqual([]); // nothing queued: the poll alone must count
      const after = Date.now();

      health = await relay.operatorRequest("GET", "/v1/operator/fleet-health");
      row = health.body.agents.find((x: { id: string }) => x.id === a.agent_id);
      isoWithin(row.last_inbox_poll_at, before, after);
      const first = row.last_inbox_poll_at as string;

      // The column is a "most recent", not a "first": a later poll moves it.
      await new Promise((r) => setTimeout(r, 5));
      await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
      health = await relay.operatorRequest("GET", "/v1/operator/fleet-health");
      row = health.body.agents.find((x: { id: string }) => x.id === a.agent_id);
      expect(Date.parse(row.last_inbox_poll_at)).toBeGreaterThanOrEqual(Date.parse(first));
      expect(row.last_inbox_poll_at).not.toBe(first);
    });

    it("heartbeats do not count as polls: an agent that heartbeats but never fetches keeps last_inbox_poll_at null (design §1.5)", async () => {
      const live = await relay.enrollAgent("dp-hb-only");
      await relay.agentRequest(live.agent_id, live.secret, "POST", "/v1/heartbeats", { status: "healthy", metrics: {} });
      await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: live.agent_id, text: "anyone there?" });
      await relay.agentRequest(live.agent_id, live.secret, "POST", "/v1/heartbeats", { status: "healthy", metrics: {} });

      const health = await relay.operatorRequest("GET", "/v1/operator/fleet-health");
      const row = health.body.agents.find((x: { id: string }) => x.id === live.agent_id);
      expect(row.last_heartbeat_at).not.toBeNull();
      expect(row.last_inbox_poll_at).toBeNull();
      // The only existing per-agent liveness fields are heartbeat-derived.
      expect(row.health.level).toBe("ok");
    });

    it("is per agent: one agent's poll never stamps a teammate", async () => {
      const a = await relay.enrollAgent("dp-poll-self");
      const b = await relay.enrollAgent("dp-poll-other");
      await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");

      const health = await relay.operatorRequest("GET", "/v1/operator/fleet-health");
      const rowA = health.body.agents.find((x: { id: string }) => x.id === a.agent_id);
      const rowB = health.body.agents.find((x: { id: string }) => x.id === b.agent_id);
      expect(rowA.last_inbox_poll_at).not.toBeNull();
      expect(rowB.last_inbox_poll_at).toBeNull();
    });

    it("is operator-only: the agent inbox and the sender's status read-back never expose a teammate's poll time", async () => {
      const a = await relay.enrollAgent("dp-poll-priv-a");
      const b = await relay.enrollAgent("dp-poll-priv-b");
      await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
      const sent = await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: b.agent_id },
        message_type: "direct",
        body: { text: "ping" },
        conversation_id: "dp-priv",
        correlation_id: "dp-priv-1"
      });
      const id = sent.body.message_id as string;
      const inbox = await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
      const status = await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/messages/${id}/status`);
      expect(JSON.stringify(inbox.body)).not.toContain("last_inbox_poll_at");
      expect(JSON.stringify(status.body)).not.toContain("last_inbox_poll_at");
    });
  });

  describe("message_deliveries.ack_recorded_at", () => {
    async function sendDirect(from: { agent_id: string; secret: string }, to: { agent_id: string }, conv: string) {
      const sent = await relay.agentRequest(from.agent_id, from.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: to.agent_id },
        message_type: "direct",
        body: { text: "please run the migration" },
        conversation_id: conv,
        correlation_id: `${conv}-cor`
      });
      expect(sent.status).toBe(200);
      return sent.body.message_id as string;
    }

    it("is the RELAY clock, next to the adapter-supplied acked_at, and only after the ack arrives", async () => {
      const b = await relay.enrollAgent("dp-ack-b");
      const c = await relay.enrollAgent("dp-ack-c");
      const id = await sendDirect(c, b, "dp-ack-1");

      await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
      let status = await relay.agentRequest(c.agent_id, c.secret, "GET", `/v1/messages/${id}/status`);
      let [d] = status.body.deliveries;
      expect(d.status).toBe("delivered");
      expect(d.acked_at).toBeNull();
      expect(d.ack_recorded_at).toBeNull();

      // The adapter's clock is an hour fast. acked_at keeps that value verbatim
      // (today's behaviour, not changed); ack_recorded_at is what the relay saw.
      const skewed = new Date(Date.now() + 3_600_000).toISOString();
      const before = Date.now();
      const ack = await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/acks", {
        acks: [{ message_id: id, status: "received", received_at: skewed }]
      });
      expect(ack.status).toBe(200);
      const after = Date.now();

      status = await relay.agentRequest(c.agent_id, c.secret, "GET", `/v1/messages/${id}/status`);
      [d] = status.body.deliveries;
      expect(d.status).toBe("acked");
      expect(d.acked_at).toBe(skewed);
      isoWithin(d.ack_recorded_at, before, after);
      expect(Date.parse(d.ack_recorded_at)).toBeLessThan(Date.parse(d.acked_at));
    });

    it("is written once: a duplicate ack changes neither acked_at nor ack_recorded_at", async () => {
      const b = await relay.enrollAgent("dp-ack2-b");
      const c = await relay.enrollAgent("dp-ack2-c");
      const id = await sendDirect(c, b, "dp-ack-2");
      await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
      const firstAt = new Date().toISOString();
      await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/acks", {
        acks: [{ message_id: id, status: "received", received_at: firstAt }]
      });
      const s1 = await relay.agentRequest(c.agent_id, c.secret, "GET", `/v1/messages/${id}/status`);
      const d1 = s1.body.deliveries[0];

      await new Promise((r) => setTimeout(r, 5));
      const again = await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/acks", {
        acks: [{ message_id: id, status: "received", received_at: new Date().toISOString() }]
      });
      expect(again.status).toBe(200);
      const s2 = await relay.agentRequest(c.agent_id, c.secret, "GET", `/v1/messages/${id}/status`);
      const d2 = s2.body.deliveries[0];
      expect(d2.acked_at).toBe(d1.acked_at);
      expect(d2.ack_recorded_at).toBe(d1.ack_recorded_at);
    });

    it("touches only the acking agent's own delivery row on a broadcast", async () => {
      const b = await relay.enrollAgent("dp-ack3-b");
      const c = await relay.enrollAgent("dp-ack3-c");
      const res = await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: "broadcast", text: "status please" });
      const id = res.body.message_id as string;
      await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
      await relay.agentRequest(c.agent_id, c.secret, "GET", "/v1/inbox");
      await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/acks", {
        acks: [{ message_id: id, status: "received", received_at: new Date().toISOString() }]
      });

      const rows = relay.db.db.prepare(
        "SELECT recipient_agent_id, status, acked_at, ack_recorded_at FROM message_deliveries WHERE message_id = ? ORDER BY recipient_agent_id"
      ).all(id) as Array<{ recipient_agent_id: string; status: string; acked_at: string | null; ack_recorded_at: string | null }>;
      const rowB = rows.find((r) => r.recipient_agent_id === b.agent_id)!;
      const rowC = rows.find((r) => r.recipient_agent_id === c.agent_id)!;
      expect(rowB.status).toBe("acked");
      expect(rowB.ack_recorded_at).not.toBeNull();
      expect(rowC.status).toBe("delivered");
      expect(rowC.acked_at).toBeNull();
      expect(rowC.ack_recorded_at).toBeNull();
    });

    it("never writes or returns message content, keys or paths into the timing fields", async () => {
      const b = await relay.enrollAgent("dp-ack4-b");
      const c = await relay.enrollAgent("dp-ack4-c");
      const id = await sendDirect(c, b, "dp-ack-4");
      await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
      await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/acks", {
        acks: [{ message_id: id, status: "received", received_at: new Date().toISOString() }]
      });
      const status = await relay.agentRequest(c.agent_id, c.secret, "GET", `/v1/messages/${id}/status`);
      const [d] = status.body.deliveries;
      for (const key of ["queued_at", "delivered_at", "acked_at", "ack_recorded_at"]) {
        expect(typeof d[key]).toBe("string");
        expect(Number.isFinite(Date.parse(d[key]))).toBe(true); // a timestamp, nothing else
      }
      expect(JSON.stringify(status.body)).not.toContain("please run the migration");
      expect(JSON.stringify(status.body)).not.toContain(b.secret);
    });
  });

  describe("migration 025_delivery_phases", () => {
    it("adds both columns to a pre-025 database and leaves existing rows readable with nulls", () => {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
      // A v0.7.7 database: both tables in their pre-025 shape.
      db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, fleet_id TEXT, display_name TEXT, runtime TEXT, status TEXT,
                 hostname TEXT, policy_profile TEXT, created_at TEXT, last_seen_at TEXT, revoked_at TEXT,
                 consecutive_missed_heartbeats INTEGER NOT NULL DEFAULT 0, auto_quarantined_at TEXT, quarantine_reason TEXT,
                 operator_trusted INTEGER NOT NULL DEFAULT 0, peer_autoreply INTEGER NOT NULL DEFAULT 1,
                 peer_turn_budget INTEGER NOT NULL DEFAULT 0)`);
      db.exec(`CREATE TABLE message_deliveries (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, recipient_agent_id TEXT NOT NULL,
                 delivery_attempts INTEGER NOT NULL DEFAULT 0, queued_at TEXT NOT NULL, delivered_at TEXT, acked_at TEXT,
                 status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, last_failure_reason TEXT)`);
      db.exec("INSERT INTO agents (id, fleet_id, display_name, runtime, status, policy_profile, created_at) VALUES ('ag_1', 'f', 'one', 'openclaw', 'active', 'default', '2026-11-01T00:00:00.000Z')");
      db.exec("INSERT INTO message_deliveries (id, message_id, recipient_agent_id, queued_at, acked_at, status) VALUES ('d_1', 'm_1', 'ag_1', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:05.000Z', 'acked')");
      const mark = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
      for (let v = 1; v <= 24; v++) mark.run(v, "2026-11-01T00:00:00.000Z");

      runMigrationsOn(db, REAL_MIGRATIONS_DIR);

      const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map((r) => r.version);
      expect(versions).toContain(25);
      const agent = db.prepare("SELECT last_inbox_poll_at FROM agents WHERE id = 'ag_1'").get() as { last_inbox_poll_at: string | null };
      expect(agent.last_inbox_poll_at).toBeNull();
      const delivery = db.prepare("SELECT acked_at, ack_recorded_at FROM message_deliveries WHERE id = 'd_1'").get() as { acked_at: string; ack_recorded_at: string | null };
      // A pre-upgrade ack keeps its adapter time and has no relay time: null, never backfilled from acked_at.
      expect(delivery.acked_at).toBe("2026-11-01T00:00:05.000Z");
      expect(delivery.ack_recorded_at).toBeNull();

      // Re-running is a no-op.
      runMigrationsOn(db, REAL_MIGRATIONS_DIR);
      expect((db.prepare("SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 25").get() as { c: number }).c).toBe(1);
    });

    it("is a no-op on a fresh schema.ts database (both paths define the same columns)", () => {
      const db = new Database(":memory:");
      db.exec(schemaSql);
      runMigrationsOn(db, REAL_MIGRATIONS_DIR);
      const agentCols = (db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).map((c) => c.name);
      const deliveryCols = (db.prepare("PRAGMA table_info(message_deliveries)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(agentCols.filter((c) => c === "last_inbox_poll_at")).toHaveLength(1);
      expect(deliveryCols.filter((c) => c === "ack_recorded_at")).toHaveLength(1);
    });
  });
});
