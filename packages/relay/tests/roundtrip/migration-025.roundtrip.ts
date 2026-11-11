import { createTestRelay, type TestRelay } from "../setup"; // sets the shared test env (session secret, limits)
import { it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * Migration 025 round trip across two relay builds, on ONE SQLite file.
 *
 * This file is NOT part of the ordinary suite (it does not match
 * tests/**\/*.test.ts). It runs only through vitest.roundtrip.config.ts, from
 * the `migration-roundtrip` CI job, which copies it unchanged into a checkout
 * of the previous release and runs four phases in order against one database:
 *
 *   A  previous build  creates the database and writes rows
 *   B  this build      boots on that file: 025 applies once, old rows keep
 *                      NULL in both new columns, new poll + ack write them
 *   C  previous build  boots on the migrated file: every route it serves
 *                      still answers, the phase-B values are untouched
 *   D  this build      boots again: 025 is not re-applied, values intact,
 *                      new writes still land
 *
 * Each phase is a separate process, so a build never shares a module graph
 * with the other one. What carries between phases is the database file and a
 * small state file beside it (ids, throwaway test credentials, timestamps).
 *
 * Nothing here imports relay source statically: `../setup` loads the relay
 * lazily inside createTestRelay(), after EKHO_DB_PATH below is in place.
 *
 * Environment (all required):
 *   EKHO_ROUNDTRIP_PHASE   A | B | C | D
 *   EKHO_ROUNDTRIP_EXPECT  previous | head   which build this tree must be
 *   EKHO_ROUNDTRIP_DIR     existing directory that holds the database + state
 */

type Phase = "A" | "B" | "C" | "D";
type Creds = { agent_id: string; secret: string };
type State = {
  completed: Phase[];
  fleetId: string;
  operatorId: string;
  agents: Record<string, Creds>;
  messages: Record<string, string>;
  /** Values written by this build in phase B; later phases must find them unchanged. */
  phaseB?: { a2LastInboxPollAt: string; m2AckRecordedAt: string; v25AppliedAt: string };
};

const PHASE = (process.env.EKHO_ROUNDTRIP_PHASE ?? "") as Phase;
const EXPECT = process.env.EKHO_ROUNDTRIP_EXPECT ?? "";
const DIR = process.env.EKHO_ROUNDTRIP_DIR ?? "";
const DB_PATH = path.join(DIR, "roundtrip.sqlite");
const STATE_PATH = path.join(DIR, "state.json");
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");
const NEW_AGENT_COLUMN = "last_inbox_poll_at";
const NEW_DELIVERY_COLUMN = "ack_recorded_at";
const PRIOR: Record<Phase, Phase[]> = { A: [], B: ["A"], C: ["A", "B"], D: ["A", "B", "C"] };

// Point the relay singleton at the shared file. `../setup` has already set a
// private temp path; this overrides it before any relay module is imported.
if (DIR) process.env.EKHO_DB_PATH = DB_PATH;

const log = (msg: string) => console.log(`[roundtrip] phase ${PHASE}: ${msg}`);

const treeHasMigration025 = () =>
  fs.existsSync(MIGRATIONS_DIR) && fs.readdirSync(MIGRATIONS_DIR).some((f) => f.startsWith("025_"));

const columns = (raw: Database.Database, table: string) =>
  (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

const versions = (raw: Database.Database) =>
  (raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map((r) => r.version);

const v25Rows = (raw: Database.Database) =>
  raw.prepare("SELECT version, applied_at FROM schema_migrations WHERE version = 25").all() as Array<{ version: number; applied_at: string }>;

/** Read a column that only exists after 025; `absent` when the table lacks it. */
function readNewColumn(raw: Database.Database, table: "agents" | "message_deliveries", idColumn: string, idValue: string) {
  const col = table === "agents" ? NEW_AGENT_COLUMN : NEW_DELIVERY_COLUMN;
  if (!columns(raw, table).includes(col)) return "absent" as const;
  const row = raw.prepare(`SELECT ${col} AS v FROM ${table} WHERE ${idColumn} = ?`).get(idValue) as { v: string | null } | undefined;
  expect(row, `${table} row for ${idValue}`).toBeDefined();
  return row!.v;
}

const pollAt = (raw: Database.Database, agentId: string) => readNewColumn(raw, "agents", "id", agentId);
const ackRecordedAt = (raw: Database.Database, messageId: string) => readNewColumn(raw, "message_deliveries", "message_id", messageId);

function loadState(): State {
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as State;
}

function saveState(state: State) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/** Operator and enrolment helpers bound to the fleet phase A created, so every
 *  phase works on the SAME fleet rather than the fresh one createTestRelay adds. */
async function fleetTools(relay: TestRelay, state: Pick<State, "fleetId" | "operatorId">) {
  const { issueOperatorSession } = await import("../../src/operator-session");
  const token = issueOperatorSession("test-secret", state.operatorId, state.fleetId, Math.floor(Date.now() / 1000));

  async function operatorGet(url: string) {
    const res = await relay.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  async function enroll(displayName: string): Promise<Creds> {
    const enrollmentToken = relay.db.issueEnrollmentToken(state.fleetId, state.operatorId);
    const res = await relay.app.inject({
      method: "POST",
      url: "/v1/enroll",
      payload: { fleet_id: state.fleetId, token: enrollmentToken, display_name: displayName, runtime: "custom" }
    });
    expect(res.statusCode, `enroll ${displayName}`).toBeLessThan(300);
    const body = JSON.parse(res.body) as Creds;
    expect(body.agent_id).toBeTruthy();
    expect(body.secret).toBeTruthy();
    return { agent_id: body.agent_id, secret: body.secret };
  }

  async function send(from: Creds, to: Creds, tag: string) {
    const res = await relay.agentRequest(from.agent_id, from.secret, "POST", "/v1/messages", {
      recipient: { kind: "agent", id: to.agent_id },
      message_type: "direct",
      body: { text: `roundtrip ${tag}` },
      conversation_id: `roundtrip-${tag}`,
      correlation_id: `roundtrip-${tag}`
    });
    expect(res.status, `send ${tag}`).toBe(200);
    expect(res.body.message_id).toBeTruthy();
    return res.body.message_id as string;
  }

  /** Poll the inbox and require the named message to be in the batch. */
  async function pollExpecting(who: Creds, messageId: string | null, tag: string) {
    const res = await relay.agentRequest(who.agent_id, who.secret, "GET", "/v1/inbox");
    expect(res.status, `poll ${tag}`).toBe(200);
    expect(Array.isArray(res.body.messages)).toBe(true);
    if (messageId) {
      const ids = (res.body.messages as Array<{ id?: string; message_id?: string }>).map((m) => m.id ?? m.message_id);
      expect(ids, `poll ${tag} delivers the queued message`).toContain(messageId);
    }
  }

  async function ack(who: Creds, messageId: string, tag: string) {
    const res = await relay.agentRequest(who.agent_id, who.secret, "POST", "/v1/acks", {
      acks: [{ message_id: messageId, status: "received", received_at: new Date().toISOString() }]
    });
    expect(res.status, `ack ${tag}`).toBe(200);
    expect(res.body.updated, `ack ${tag} updated one delivery`).toBe(1);
  }

  async function statusOf(sender: Creds, messageId: string, tag: string) {
    const res = await relay.agentRequest(sender.agent_id, sender.secret, "GET", `/v1/messages/${messageId}/status`);
    expect(res.status, `status ${tag}`).toBe(200);
    expect(Array.isArray(res.body.deliveries)).toBe(true);
    return res.body.deliveries[0] as { status: string; ack_recorded_at?: string | null };
  }

  /** Both operator read models over the whole fleet, including every agent
   *  and delivery earlier phases wrote. */
  async function operatorViews(expectedAgentIds: string[]) {
    const health = await operatorGet("/v1/operator/fleet-health");
    expect(health.status, "fleet-health").toBe(200);
    const seen = (health.body.agents as Array<{ id: string }>).map((a) => a.id);
    for (const id of expectedAgentIds) expect(seen, "fleet-health lists every enrolled agent").toContain(id);
    const topology = await operatorGet("/v1/operator/topology");
    expect(topology.status, "topology").toBe(200);
    return health.body.agents as Array<{ id: string; last_inbox_poll_at?: string | null }>;
  }

  return { enroll, send, pollExpecting, ack, statusOf, operatorViews };
}

function closeOut(relay: TestRelay) {
  relay.cleanup();
  const raw = relay.db.raw();
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
}

it(`migration 025 round trip, phase ${PHASE || "(unset)"}`, async () => {
  // --- guards: wrong wiring must fail loudly, never pass by doing nothing ---
  expect(["A", "B", "C", "D"], "EKHO_ROUNDTRIP_PHASE").toContain(PHASE);
  expect(["previous", "head"], "EKHO_ROUNDTRIP_EXPECT").toContain(EXPECT);
  expect(DIR && fs.statSync(DIR).isDirectory(), "EKHO_ROUNDTRIP_DIR must be an existing directory").toBe(true);
  // A and C belong to the previous build, B and D to this one.
  expect(EXPECT, `phase ${PHASE} runs on the ${PHASE === "A" || PHASE === "C" ? "previous" : "head"} build`).toBe(
    PHASE === "A" || PHASE === "C" ? "previous" : "head"
  );
  // The tree this process runs in must actually be the build the phase names.
  expect(treeHasMigration025(), `tree carries migration 025 (expected build: ${EXPECT})`).toBe(EXPECT === "head");

  if (PHASE === "A") {
    expect(fs.existsSync(DB_PATH), "phase A starts with no database").toBe(false);
    expect(fs.existsSync(STATE_PATH), "phase A starts with no state").toBe(false);
  } else {
    expect(fs.existsSync(DB_PATH), "earlier phases left the database").toBe(true);
    expect(loadState().completed, "phases run in order, once each").toEqual(PRIOR[PHASE]);
  }

  // --- what the file looks like BEFORE this build touches it ---
  let before: { versions: number[]; v25: Array<{ applied_at: string }>; agentCols: string[]; deliveryCols: string[] } | null = null;
  if (PHASE !== "A") {
    const raw = new Database(DB_PATH, { fileMustExist: true });
    before = { versions: versions(raw), v25: v25Rows(raw), agentCols: columns(raw, "agents"), deliveryCols: columns(raw, "message_deliveries") };
    raw.close();
    log(`before boot: highest migration ${Math.max(...before.versions)}, version-25 rows ${before.v25.length}`);
  }

  if (PHASE === "B") {
    // The database really is in the previous build's shape: 025 has not run.
    expect(before!.versions).not.toContain(25);
    expect(before!.agentCols).not.toContain(NEW_AGENT_COLUMN);
    expect(before!.deliveryCols).not.toContain(NEW_DELIVERY_COLUMN);
  }
  if (PHASE === "C" || PHASE === "D") {
    expect(before!.v25).toHaveLength(1);
    expect(before!.agentCols).toContain(NEW_AGENT_COLUMN);
    expect(before!.deliveryCols).toContain(NEW_DELIVERY_COLUMN);
  }

  // --- boot this tree's relay on the shared file ---
  const relay = await createTestRelay();
  const raw = relay.db.raw();
  expect(raw.name, "relay opened the shared database").toBe(DB_PATH);
  log(`booted ${EXPECT} build; migrations applied: ${versions(raw).length}, highest ${Math.max(...versions(raw))}`);

  try {
    if (PHASE === "A") {
      const state: State = { completed: [], fleetId: relay.fleetId, operatorId: relay.operatorId, agents: {}, messages: {} };
      const t = await fleetTools(relay, state);

      expect(versions(raw)).not.toContain(25);
      expect(columns(raw, "agents")).not.toContain(NEW_AGENT_COLUMN);
      expect(columns(raw, "message_deliveries")).not.toContain(NEW_DELIVERY_COLUMN);

      state.agents.a1 = await t.enroll("roundtrip-a1");
      state.agents.a2 = await t.enroll("roundtrip-a2");
      // m1: full send, poll, ack on the previous build.
      state.messages.m1 = await t.send(state.agents.a1, state.agents.a2, "a-m1");
      await t.pollExpecting(state.agents.a2, state.messages.m1, "a2 m1");
      await t.ack(state.agents.a2, state.messages.m1, "m1");
      expect((await t.statusOf(state.agents.a1, state.messages.m1, "m1")).status).toBe("acked");
      // m2: sent on the previous build, left queued for this build to deliver.
      state.messages.m2 = await t.send(state.agents.a1, state.agents.a2, "a-m2");
      await t.operatorViews([state.agents.a1.agent_id, state.agents.a2.agent_id]);

      log("previous build created the database; enrol x2, send x2, poll, ack, status, fleet-health, topology all 200");
      state.completed.push("A");
      saveState(state);
    }

    if (PHASE === "B") {
      const state = loadState();
      const t = await fleetTools(relay, state);
      const { a1, a2 } = state.agents;

      // 025 applied exactly once, by this boot.
      const applied = v25Rows(raw);
      expect(applied).toHaveLength(1);
      expect(columns(raw, "agents")).toContain(NEW_AGENT_COLUMN);
      expect(columns(raw, "message_deliveries")).toContain(NEW_DELIVERY_COLUMN);
      log(`migration 025 applied once at ${applied[0].applied_at}`);

      // Rows written by the previous build carry NULL in both new columns.
      expect(pollAt(raw, a1.agent_id)).toBeNull();
      expect(pollAt(raw, a2.agent_id)).toBeNull();
      expect(ackRecordedAt(raw, state.messages.m1)).toBeNull();
      expect(ackRecordedAt(raw, state.messages.m2)).toBeNull();
      log("phase-A agents and deliveries hold NULL in last_inbox_poll_at and ack_recorded_at");

      // A new poll and a new ack write them; the phase-A message is delivered.
      await t.pollExpecting(a2, state.messages.m2, "a2 m2");
      await t.ack(a2, state.messages.m2, "m2");
      const a2Poll = pollAt(raw, a2.agent_id);
      const m2Ack = ackRecordedAt(raw, state.messages.m2);
      expect(typeof a2Poll).toBe("string");
      expect(typeof m2Ack).toBe("string");
      expect(Number.isFinite(Date.parse(a2Poll as string))).toBe(true);
      expect(Number.isFinite(Date.parse(m2Ack as string))).toBe(true);
      const m2Status = await t.statusOf(a1, state.messages.m2, "m2");
      expect(m2Status.status).toBe("acked");
      expect(m2Status.ack_recorded_at).toBe(m2Ack);
      // Untouched rows stay NULL: nothing is backfilled.
      expect(pollAt(raw, a1.agent_id)).toBeNull();
      expect(ackRecordedAt(raw, state.messages.m1)).toBeNull();

      // m3: sent on this build, left queued for the previous build to deliver.
      state.agents.a3 = await t.enroll("roundtrip-a3");
      state.messages.m3 = await t.send(state.agents.a3, a1, "b-m3");
      const health = await t.operatorViews([a1.agent_id, a2.agent_id, state.agents.a3.agent_id]);
      expect(health.find((a) => a.id === a2.agent_id)?.last_inbox_poll_at).toBe(a2Poll);

      state.phaseB = { a2LastInboxPollAt: a2Poll as string, m2AckRecordedAt: m2Ack as string, v25AppliedAt: applied[0].applied_at };
      log(`new poll wrote last_inbox_poll_at=${a2Poll}; new ack wrote ack_recorded_at=${m2Ack}`);
      state.completed.push("B");
      saveState(state);
    }

    if (PHASE === "C") {
      const state = loadState();
      const t = await fleetTools(relay, state);
      const { a1, a2, a3 } = state.agents;
      const b = state.phaseB!;
      expect(b).toBeDefined();

      // The previous build has no 025 file, booted anyway, and left the
      // migration record and the columns alone.
      expect(v25Rows(raw)).toEqual([{ version: 25, applied_at: b.v25AppliedAt }]);
      expect(columns(raw, "agents")).toContain(NEW_AGENT_COLUMN);
      expect(columns(raw, "message_deliveries")).toContain(NEW_DELIVERY_COLUMN);

      // Every route the previous build serves, on rows both builds wrote.
      state.agents.a4 = await t.enroll("roundtrip-a4");
      state.messages.m4 = await t.send(state.agents.a4, a2, "c-m4");
      await t.pollExpecting(a2, state.messages.m4, "a2 m4"); // a2 holds a non-NULL last_inbox_poll_at
      await t.ack(a2, state.messages.m4, "m4");
      await t.pollExpecting(a1, state.messages.m3, "a1 m3"); // queued by the newer build
      await t.ack(a1, state.messages.m3, "m3");
      expect((await t.statusOf(state.agents.a4, state.messages.m4, "m4")).status).toBe("acked");
      expect((await t.statusOf(a3, state.messages.m3, "m3")).status).toBe("acked");
      expect((await t.statusOf(a1, state.messages.m2, "m2")).status).toBe("acked"); // delivery with ack_recorded_at set
      expect((await t.statusOf(a1, state.messages.m1, "m1")).status).toBe("acked");
      await t.operatorViews([a1.agent_id, a2.agent_id, a3.agent_id, state.agents.a4.agent_id]);
      log("previous build on the migrated file: enrol, send, poll x2, ack x2, status x4, fleet-health, topology all 200");

      // Phase-B values are byte-for-byte what this build wrote.
      expect(pollAt(raw, a2.agent_id)).toBe(b.a2LastInboxPollAt);
      expect(ackRecordedAt(raw, state.messages.m2)).toBe(b.m2AckRecordedAt);
      // The previous build never writes the new columns.
      expect(pollAt(raw, a1.agent_id)).toBeNull();
      expect(ackRecordedAt(raw, state.messages.m3)).toBeNull();
      expect(ackRecordedAt(raw, state.messages.m4)).toBeNull();
      expect(v25Rows(raw)).toHaveLength(1);
      log(`phase-B values unchanged (last_inbox_poll_at=${b.a2LastInboxPollAt}, ack_recorded_at=${b.m2AckRecordedAt}); schema_migrations has exactly one row for version 25`);

      state.completed.push("C");
      saveState(state);
    }

    if (PHASE === "D") {
      const state = loadState();
      const t = await fleetTools(relay, state);
      const { a1, a2 } = state.agents;
      const b = state.phaseB!;
      expect(b).toBeDefined();

      // 025 is not re-applied: same single row, same applied_at as phase B.
      expect(before!.v25[0].applied_at).toBe(b.v25AppliedAt);
      expect(v25Rows(raw)).toEqual([{ version: 25, applied_at: b.v25AppliedAt }]);
      expect(versions(raw)).toEqual(before!.versions);
      log(`migration 025 not re-applied (applied_at still ${b.v25AppliedAt})`);

      // Phase-B values intact, checked before this phase writes anything.
      expect(pollAt(raw, a2.agent_id)).toBe(b.a2LastInboxPollAt);
      expect(ackRecordedAt(raw, state.messages.m2)).toBe(b.m2AckRecordedAt);
      // Rows the previous build wrote in phase C are still NULL.
      expect(pollAt(raw, a1.agent_id)).toBeNull();
      expect(ackRecordedAt(raw, state.messages.m4)).toBeNull();

      // New writes still land.
      state.agents.a5 = await t.enroll("roundtrip-a5");
      state.messages.m5 = await t.send(state.agents.a5, a1, "d-m5");
      await t.pollExpecting(a1, state.messages.m5, "a1 m5");
      await t.ack(a1, state.messages.m5, "m5");
      const a1Poll = pollAt(raw, a1.agent_id);
      const m5Ack = ackRecordedAt(raw, state.messages.m5);
      expect(typeof a1Poll).toBe("string");
      expect(typeof m5Ack).toBe("string");
      const m5Status = await t.statusOf(state.agents.a5, state.messages.m5, "m5");
      expect(m5Status.status).toBe("acked");
      expect(m5Status.ack_recorded_at).toBe(m5Ack);
      const health = await t.operatorViews(Object.values(state.agents).map((a) => a.agent_id));
      expect(health.find((a) => a.id === a1.agent_id)?.last_inbox_poll_at).toBe(a1Poll);
      // The phase-B delivery value survives this phase's writes too.
      expect(ackRecordedAt(raw, state.messages.m2)).toBe(b.m2AckRecordedAt);
      log(`phase-B values intact; new poll wrote last_inbox_poll_at=${a1Poll}; new ack wrote ack_recorded_at=${m5Ack}`);

      state.completed.push("D");
      saveState(state);
    }

    log("PASS");
  } finally {
    closeOut(relay);
  }
});
