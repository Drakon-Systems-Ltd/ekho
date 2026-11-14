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
 *                                      batch is empty. Evidence of recent
 *                                      polling only: a stale value says the
 *                                      adapter is not fetching, whether wedged
 *                                      or mid-turn. Design §2.3's retained turn
 *                                      intervals (Phase 1b) tell those apart.
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
      // Timestamps are millisecond ISO strings, so sleep well past 1 ms.
      await new Promise((r) => setTimeout(r, 25));
      await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
      health = await relay.operatorRequest("GET", "/v1/operator/fleet-health");
      row = health.body.agents.find((x: { id: string }) => x.id === a.agent_id);
      expect(Date.parse(row.last_inbox_poll_at)).toBeGreaterThan(Date.parse(first));
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

    it("is operator-only: an agent-signed request for fleet-health is refused", async () => {
      const a = await relay.enrollAgent("dp-poll-auth");
      await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
      // Agent credentials are not operator credentials: the only read-back of
      // last_inbox_poll_at sits behind requireOperatorAuth, unchanged here.
      const res = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/operator/fleet-health");
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain("last_inbox_poll_at");
    });

    it("is also carried on operator topology nodes, and an agent-signed topology request is refused", async () => {
      const a = await relay.enrollAgent("dp-topo-polled");
      const b = await relay.enrollAgent("dp-topo-silent");
      const before = Date.now();
      await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
      const after = Date.now();

      // Topology nodes are built from the fleet-health rows, so the operator
      // sees the same poll time there.
      const topo = await relay.operatorRequest("GET", "/v1/operator/topology");
      expect(topo.status).toBe(200);
      const nodeA = topo.body.nodes.find((n: { id: string }) => n.id === a.agent_id);
      const nodeB = topo.body.nodes.find((n: { id: string }) => n.id === b.agent_id);
      isoWithin(nodeA.last_inbox_poll_at, before, after);
      expect(nodeB.last_inbox_poll_at).toBeNull();

      // Agent credentials do not open it: no nodes, no poll times.
      const res = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/operator/topology");
      expect(res.status).toBe(401);
      expect(res.body.nodes).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain("last_inbox_poll_at");
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

describe("#155 phase 1b: bounded relay phase reports", () => {
  let relay: TestRelay;
  beforeEach(async () => { relay = await createTestRelay(); });
  afterEach(() => { relay.cleanup(); });

  const at = () => new Date().toISOString();
  async function direct(from: { agent_id: string; secret: string }, to: { agent_id: string }, metadata?: Record<string, unknown>) {
    const sent = await relay.agentRequest(from.agent_id, from.secret, "POST", "/v1/messages", {
      recipient: { kind: "agent", id: to.agent_id }, message_type: "direct", body: { text: "reply" },
      conversation_id: `phase-${Math.random()}`, correlation_id: `phase-${Math.random()}`, metadata
    });
    expect(sent.status).toBe(200);
    return sent.body.message_id as string;
  }
  async function status(sender: { agent_id: string; secret: string }, id: string) {
    const res = await relay.agentRequest(sender.agent_id, sender.secret, "GET", `/v1/messages/${id}/status`);
    expect(res.status).toBe(200);
    return res.body.deliveries as Array<Record<string, unknown>>;
  }
  async function report(agent: { agent_id: string; secret: string }, phases: unknown[]) {
    return relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/delivery-phases", { phases });
  }

  it("authenticates, validates, and scopes reports to the recipient", async () => {
    const a = await relay.enrollAgent("phase-a");
    const b = await relay.enrollAgent("phase-b");
    const sent = await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/messages", { recipient: { kind: "agent", id: b.agent_id }, message_type: "direct", body: { text: "hello" }, conversation_id: "phase-auth", correlation_id: "phase-auth" });
    const phase = { message_id: sent.body.message_id, phase: "floor_wait", at: new Date().toISOString(), holder_agent_id: a.agent_id };
    const foreign = await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/delivery-phases", { phases: [phase] });
    expect(foreign.status).toBe(200);
    expect(foreign.body.recorded).toBe(0);
    expect((await relay.app.inject({ method: "POST", url: "/v1/delivery-phases", payload: { phases: [phase] } })).statusCode).toBe(401);
    expect((await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/delivery-phases", { phases: [{ ...phase, detail: "secret" }] })).status).toBe(400);
    expect((await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/delivery-phases", { phases: [{ ...phase, phase: "arbitrary" }] })).status).toBe(400);
    expect((await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/delivery-phases", { phases: [phase] })).body.recorded).toBe(1);
    const status = await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/messages/${sent.body.message_id}/status`);
    expect(status.body.deliveries[0]).not.toHaveProperty("floor_holder_agent_id");
    expect(JSON.stringify(status.body)).not.toContain("floor_holder_agent_id");
    expect((relay.db.raw().prepare("SELECT floor_holder_agent_id FROM message_deliveries WHERE message_id = ? AND recipient_agent_id = ?")
      .get(sent.body.message_id, b.agent_id) as { floor_holder_agent_id: string | null }).floor_holder_agent_id).toBe(a.agent_id);
  });

  it("reconciles late reports and replies across attempts without losing the earliest output", async () => {
    const a = await relay.enrollAgent("phase-r-a");
    const b = await relay.enrollAgent("phase-r-b");
    const send = async (from: typeof a, to: typeof b, turn?: string) => relay.agentRequest(from.agent_id, from.secret, "POST", "/v1/messages", { recipient: { kind: "agent", id: to.agent_id }, message_type: "direct", body: { text: "x" }, metadata: turn ? { turn_id: turn } : undefined, conversation_id: "phase-r", correlation_id: `phase-${Math.random()}` });
    const original = await send(a, b);
    const id = original.body.message_id;
    const at = new Date().toISOString();
    const report = async (phases: unknown[]) => relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/delivery-phases", { phases });
    await send(b, a, "turn.2"); // reply arrives before the matching report
    expect((await report([{ message_id: id, phase: "turn_started", at, turn_id: "turn.2", attempt: 2 }])).body.recorded).toBe(1);
    await report([{ message_id: id, phase: "turn_started", at, turn_id: "turn.1", attempt: 1 }, { message_id: id, phase: "turn_ended", at, turn_id: "turn.1", attempt: 1, outcome: "spawn_failed", category: "spawn_error_retained" }]);
    let d = (await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/messages/${id}/status`)).body.deliveries[0];
    expect(d.latest_attempt).toBe(2);
    expect(d.latest_turn_outcome).toBeNull();
    expect(d.first_reply_turn_id).toBe("turn.2");
    await report([{ message_id: id, phase: "turn_ended", at, turn_id: "turn.2", attempt: 2, outcome: "completed" }]);
    d = (await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/messages/${id}/status`)).body.deliveries[0];
    expect(d.latest_turn_outcome).toBe("completed");
    expect(d.first_reply_turn_id).toBe("turn.2");
    expect(d.turn_attempts).toBe(2);
    await send(b, a, "turn.1"); // older attempt replies later in wall time
    expect((await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/messages/${id}/status`)).body.deliveries[0].first_reply_turn_id).toBe("turn.2");
  });

  it("joins report-before-reply and keeps the earliest reply after duplicates", async () => {
    const a = await relay.enrollAgent("phase-order-a");
    const b = await relay.enrollAgent("phase-order-b");
    const id = await direct(a, b);
    const phase = { message_id: id, phase: "turn_started", at: at(), turn_id: "order.1", attempt: 1 };
    expect((await report(b, [phase, phase])).body).toEqual({ recorded: 2, refused: 0 });
    expect((await status(a, id))[0].turn_attempts).toBe(1);
    expect((await status(a, id))[0].first_reply_at).toBeNull();
    await direct(b, a, { turn_id: "order.1" });
    const first = (await status(a, id))[0];
    expect(first.first_reply_turn_id).toBe("order.1");
    expect(first.first_reply_at).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    await direct(b, a, { turn_id: "order.1" });
    expect((await status(a, id))[0].first_reply_at).toBe(first.first_reply_at);
    expect((await report(b, [phase])).body).toEqual({ recorded: 1, refused: 0 });
    expect((await status(a, id))[0].turn_attempts).toBe(1);
  });

  it("isolates broadcast delivery rows and rejects foreign or malformed floor holders", async () => {
    const a = await relay.enrollAgent("phase-cast-a");
    const b = await relay.enrollAgent("phase-cast-b");
    const c = await relay.enrollAgent("phase-cast-c");
    const cast = await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: "broadcast", text: "ping" });
    const id = cast.body.message_id as string;
    const phase = { message_id: id, phase: "floor_wait", at: at(), holder_agent_id: a.agent_id };
    expect((await report(b, [phase])).body).toEqual({ recorded: 1, refused: 0 });
    const rows = relay.db.raw().prepare("SELECT recipient_agent_id, floor_holder_agent_id FROM message_deliveries WHERE message_id = ?").all(id) as
      Array<{ recipient_agent_id: string; floor_holder_agent_id: string | null }>;
    expect(rows.find((r) => r.recipient_agent_id === b.agent_id)?.floor_holder_agent_id).toBe(a.agent_id);
    expect(rows.find((r) => r.recipient_agent_id === c.agent_id)?.floor_holder_agent_id).toBeNull();
    expect((await report(c, [{ ...phase, holder_agent_id: "agt_nonexistent" }])).body).toEqual({ recorded: 1, refused: 0 });
    expect((relay.db.raw().prepare("SELECT floor_holder_agent_id FROM message_deliveries WHERE message_id = ? AND recipient_agent_id = ?").get(id, c.agent_id) as { floor_holder_agent_id: string | null }).floor_holder_agent_id).toBeNull();
    expect((await report(c, [{ ...phase, holder_agent_id: "bad holder" }])).status).toBe(400);
    const otherFleet = await createTestRelay();
    try {
      const foreign = await otherFleet.enrollAgent("phase-foreign-holder");
      expect((await report(c, [{ ...phase, holder_agent_id: foreign.agent_id }])).body).toEqual({ recorded: 1, refused: 0 });
    } finally { otherFleet.cleanup(); }
    expect((await report(a, [{ ...phase, holder_agent_id: a.agent_id }])).body).toEqual({ recorded: 1, refused: 0 });
    expect((await report(b, [{ ...phase, message_id: "msg_foreign" }])).body).toEqual({ recorded: 0, refused: 1 });
  });

  it("clamps untrusted phase time and locks terminal dead letters", async () => {
    const a = await relay.enrollAgent("phase-terminal-a");
    const b = await relay.enrollAgent("phase-terminal-b");
    const id = await direct(a, b);
    const before = Date.now();
    const old = new Date(before - 2 * 86400000).toISOString();
    const future = new Date(before + 2 * 86400000).toISOString();
    const phases = [
      { message_id: id, phase: "floor_wait", at: old, holder_agent_id: a.agent_id },
      { message_id: id, phase: "dead_lettered", at: future, reason: "deferred_evicted_cap" }
    ];
    expect((await report(b, phases)).body).toEqual({ recorded: 2, refused: 0 });
    const d = (await status(a, id))[0];
    for (const key of ["floor_wait_started_at", "adapter_dead_lettered_at"]) {
      expect(Date.parse(d[key] as string)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(d[key] as string)).toBeLessThanOrEqual(Date.now());
    }
    expect(d.adapter_dead_letter_reason).toBe("deferred_evicted_cap");
    expect((await report(b, [{ message_id: id, phase: "turn_started", at: at(), turn_id: "too.late", attempt: 1 }])).body)
      .toEqual({ recorded: 0, refused: 1 });
    expect((await status(a, id))[0].turn_attempts).toBe(0);
  });

  it("retains a terminal spawn error and refuses a new turn", async () => {
    const a = await relay.enrollAgent("phase-spawn-a");
    const b = await relay.enrollAgent("phase-spawn-b");
    const id = await direct(a, b);
    const ended = { message_id: id, phase: "turn_ended", at: at(), turn_id: "spawn.1", attempt: 1,
      outcome: "spawn_failed", category: "spawn_error" };
    expect((await report(b, [ended])).body).toEqual({ recorded: 1, refused: 0 });
    expect((await report(b, [ended])).body).toEqual({ recorded: 1, refused: 0 });
    expect((await report(b, [{ ...ended, phase: "turn_started", turn_id: "spawn.2", attempt: 2,
      outcome: undefined, category: undefined }])).body).toEqual({ recorded: 0, refused: 1 });
    const d = (await status(a, id))[0];
    expect(d.turn_attempts).toBe(1);
    expect(d.latest_turn_outcome).toBe("spawn_failed");
  });

  it("accepts delayed older attempt history and reply after a newer terminal attempt", async () => {
    const a = await relay.enrollAgent("phase-late-a");
    const b = await relay.enrollAgent("phase-late-b");
    const id = await direct(a, b);
    const terminal = { message_id: id, phase: "turn_ended", at: at(), turn_id: "late.2", attempt: 2,
      outcome: "spawn_failed", category: "spawn_error" };
    expect((await report(b, [terminal])).body).toEqual({ recorded: 1, refused: 0 });
    await direct(b, a, { turn_id: "late.1" });
    const older = { message_id: id, phase: "turn_started", at: at(), turn_id: "late.1", attempt: 1 };
    expect((await report(b, [older, { ...older, phase: "turn_ended", outcome: "completed" }])).body)
      .toEqual({ recorded: 2, refused: 0 });
    const d = (await status(a, id))[0];
    expect(d.turn_attempts).toBe(2);
    expect(d.latest_attempt).toBe(2);
    expect(d.latest_turn_outcome).toBe("spawn_failed");
    expect(d.first_reply_turn_id).toBe("late.1");
    expect((await report(b, [{ ...older, attempt: 3, turn_id: "late.3" }])).body)
      .toEqual({ recorded: 0, refused: 1 });
    expect((await report(b, [{ ...older, attempt: 9, turn_id: "late.9" }])).body)
      .toEqual({ recorded: 0, refused: 1 });
    expect((await status(a, id))[0]).toMatchObject({ turn_attempts: 2, attempts_capped: true });
  });

  it("caps retained attempts and ignores invalid reply metadata", async () => {
    const a = await relay.enrollAgent("phase-cap-a");
    const b = await relay.enrollAgent("phase-cap-b");
    const id = await direct(a, b);
    for (const invalid of [{ turn_id: 3 }, { turn_id: "bad turn" }, { turn_id: "x".repeat(65) }]) await direct(b, a, invalid);
    const phases = Array.from({ length: 8 }, (_, i) => ({ message_id: id, phase: "turn_started", at: at(), turn_id: `cap.${i + 1}`, attempt: i + 1 }));
    expect((await report(b, phases)).body).toEqual({ recorded: 8, refused: 0 });
    let d = (await status(a, id))[0];
    expect(d.turn_attempts).toBe(8);
    expect(d.attempts_capped).toBe(false); // eight recorded attempts are not evidence of a ninth refusal
    expect(d.first_reply_at).toBeNull();
    expect((await report(b, [{ ...phases[7], turn_id: "cap.collision" }])).body).toEqual({ recorded: 0, refused: 1 });
    expect((await status(a, id))[0].attempts_capped).toBe(false);
    expect((await report(b, [{ ...phases[7], attempt: 9, turn_id: "cap.9" }])).body).toEqual({ recorded: 0, refused: 1 });
    expect((await report(b, [{ ...phases[7], attempt: 10, turn_id: "cap.10" }])).body).toEqual({ recorded: 0, refused: 1 });
    expect((await report(b, [{ ...phases[7], attempt: 65535, turn_id: "cap.max" }])).body).toEqual({ recorded: 0, refused: 1 });
    expect((await report(b, [{ ...phases[7], attempt: 65536, turn_id: "cap.invalid" }])).status).toBe(400);
    d = (await status(a, id))[0];
    expect(d.turn_attempts).toBe(8);
    expect(d.latest_turn_id).toBe("cap.8");
    expect(d.attempts_capped).toBe(true);
    expect((relay.db.raw().prepare("SELECT COUNT(*) AS n FROM delivery_turn_attempts WHERE message_id = ?").get(id) as { n: number }).n).toBe(8);
  });

  it("flags a new overflow attempt even when fewer than eight attempts were reported", async () => {
    const a = await relay.enrollAgent("phase-gap-a");
    const b = await relay.enrollAgent("phase-gap-b");
    const id = await direct(a, b);
    expect((await report(b, [{ message_id: id, phase: "turn_started", at: at(), turn_id: "gap.9", attempt: 9 }])).body)
      .toEqual({ recorded: 0, refused: 1 });
    expect((await status(a, id))[0]).toMatchObject({ turn_attempts: 0, attempts_capped: true });
  });

  it("deletes attempt history when only its delivery is deleted", async () => {
    const a = await relay.enrollAgent("phase-cascade-a");
    const b = await relay.enrollAgent("phase-cascade-b");
    const id = await direct(a, b);
    expect((await report(b, [{ message_id: id, phase: "turn_started", at: at(), turn_id: "cascade.1", attempt: 1 }])).body)
      .toEqual({ recorded: 1, refused: 0 });
    const raw = relay.db.raw();
    expect((raw.prepare("SELECT delivery_id FROM delivery_turn_attempts WHERE message_id = ?").get(id) as { delivery_id: string }).delivery_id)
      .toBe((raw.prepare("SELECT id FROM message_deliveries WHERE message_id = ?").get(id) as { id: string }).id);
    raw.prepare("DELETE FROM message_deliveries WHERE message_id = ?").run(id);
    expect(raw.prepare("SELECT id FROM messages WHERE id = ?").get(id)).toBeTruthy();
    expect(raw.prepare("SELECT 1 FROM delivery_turn_attempts WHERE message_id = ?").get(id)).toBeUndefined();
  });

  it("prunes aged reply join cache without deleting recent replies or delivery attempts", async () => {
    const a = await relay.enrollAgent("phase-retain-a");
    const b = await relay.enrollAgent("phase-retain-b");
    const id = await direct(a, b);
    expect((await report(b, [{ message_id: id, phase: "turn_started", at: at(), turn_id: "retain.recent", attempt: 1 }])).status).toBe(200);
    const raw = relay.db.raw();
    const aged = new Date(0).toISOString();
    const recent = at();
    raw.prepare("INSERT INTO agent_turn_replies (fleet_id, agent_id, turn_id, first_reply_at) VALUES (?, ?, ?, ?)")
      .run(relay.fleetId, b.agent_id, "retain.aged", aged);
    raw.prepare("INSERT INTO agent_turn_replies (fleet_id, agent_id, turn_id, first_reply_at) VALUES (?, ?, ?, ?)")
      .run(relay.fleetId, b.agent_id, "retain.recent", recent);
    relay.db.sweepHeartbeatRetention();
    expect(raw.prepare("SELECT 1 FROM agent_turn_replies WHERE turn_id = 'retain.aged'").get()).toBeUndefined();
    expect(raw.prepare("SELECT first_reply_at FROM agent_turn_replies WHERE turn_id = 'retain.recent'").get()).toEqual({ first_reply_at: recent });
    expect(raw.prepare("SELECT 1 FROM delivery_turn_attempts WHERE message_id = ?").get(id)).toBeTruthy();
  });

  it("joins a first reply to every matching own delivery and skips duplicate reply work", async () => {
    const a = await relay.enrollAgent("phase-join-a");
    const b = await relay.enrollAgent("phase-join-b");
    const firstId = await direct(a, b);
    const secondId = await direct(a, b);
    for (const id of [firstId, secondId]) {
      expect((await report(b, [{ message_id: id, phase: "turn_started", at: at(), turn_id: "shared.1", attempt: 1 }])).body)
        .toEqual({ recorded: 1, refused: 0 });
    }
    await direct(b, a, { turn_id: "shared.1" });
    for (const id of [firstId, secondId]) expect((await status(a, id))[0].first_reply_turn_id).toBe("shared.1");
    const raw = relay.db.raw();
    raw.exec(`CREATE TRIGGER fail_duplicate_join BEFORE UPDATE OF first_reply_at ON message_deliveries
      BEGIN SELECT RAISE(ABORT, 'duplicate join ran'); END`);
    try {
      expect(await direct(b, a, { turn_id: "shared.1" })).toBeTruthy();
    } finally { raw.exec("DROP TRIGGER fail_duplicate_join"); }
  });

  it("delivers a sent message when reply observation fails", async () => {
    const a = await relay.enrollAgent("phase-atomic-a");
    const b = await relay.enrollAgent("phase-atomic-b");
    const raw = relay.db.raw();
    const before = (raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE fleet_id = ?").get(relay.fleetId) as { n: number }).n;
    raw.exec(`CREATE TRIGGER fail_reply_observation BEFORE INSERT ON agent_turn_replies
      BEGIN SELECT RAISE(ABORT, 'reply observation failed'); END`);
    const res = await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/messages", {
      recipient: { kind: "agent", id: b.agent_id }, message_type: "direct", body: { text: "atomic" },
      conversation_id: "phase-atomic", correlation_id: "phase-atomic", metadata: { turn_id: "atomic.1" }
    });
    expect(res.status).toBe(200);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE fleet_id = ?").get(relay.fleetId) as { n: number }).n).toBe(before + 1);
    expect(raw.prepare("SELECT id FROM messages WHERE id = ?").get(res.body.message_id)).toBeTruthy();
    expect(raw.prepare("SELECT id FROM message_deliveries WHERE message_id = ? AND recipient_agent_id = ?").get(res.body.message_id, b.agent_id)).toBeTruthy();
    expect(raw.prepare("SELECT 1 FROM agent_turn_replies WHERE agent_id = ? AND turn_id = ?").get(a.agent_id, "atomic.1")).toBeUndefined();
    raw.exec("DROP TRIGGER fail_reply_observation");
  });

  it("delivers the reply message but rolls back optional observation when the delivery join fails", async () => {
    const a = await relay.enrollAgent("phase-join-atomic-a");
    const b = await relay.enrollAgent("phase-join-atomic-b");
    const id = await direct(a, b);
    expect((await report(b, [{ message_id: id, phase: "turn_started", at: at(), turn_id: "join.atomic", attempt: 1 }])).body)
      .toEqual({ recorded: 1, refused: 0 });
    const raw = relay.db.raw();
    const before = (raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE fleet_id = ?").get(relay.fleetId) as { n: number }).n;
    raw.exec(`CREATE TRIGGER fail_first_reply_join BEFORE UPDATE OF first_reply_at ON message_deliveries
      BEGIN SELECT RAISE(ABORT, 'first reply join failed'); END`);
    try {
      const res = await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: a.agent_id }, message_type: "direct", body: { text: "atomic reply" },
        conversation_id: "phase-join-atomic", correlation_id: "phase-join-atomic", metadata: { turn_id: "join.atomic" }
      });
      expect(res.status).toBe(200);
      expect(raw.prepare("SELECT id FROM messages WHERE id = ?").get(res.body.message_id)).toBeTruthy();
      expect(raw.prepare("SELECT id FROM message_deliveries WHERE message_id = ? AND recipient_agent_id = ?").get(res.body.message_id, a.agent_id)).toBeTruthy();
    } finally { raw.exec("DROP TRIGGER fail_first_reply_join"); }
    expect((raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE fleet_id = ?").get(relay.fleetId) as { n: number }).n).toBe(before + 1);
    expect(raw.prepare("SELECT 1 FROM agent_turn_replies WHERE agent_id = ? AND turn_id = ?").get(b.agent_id, "join.atomic")).toBeUndefined();
    expect((await status(a, id))[0].first_reply_at).toBeNull();
  });
});
