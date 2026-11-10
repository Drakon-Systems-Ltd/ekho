import { createTestRelay } from "./setup"; // sets a temp EKHO_DB_PATH before db.ts's singleton is created
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { runMigrationsOn } from "../src/db";
import { schemaSql } from "../src/schema";

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

// Reproduces the boot sequence in the EkhoDb constructor: exec(schemaSql) THEN
// migrations. The fresh-DB suite never exercised the UPGRADE path (an existing
// DB predating a migration), which is how v0.4.0 shipped a relay that crash-
// looped on the production database with "no such column: bound_at": schema.sql
// is exec'd before migrations and referenced a column only migration 019 adds.
describe("schema.sql is exec-safe on a pre-migration (existing) database", () => {
  function bootLikeConstructor(dbPath: string) {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(schemaSql);              // must not throw on an old attachments table
    runMigrationsOn(db, MIGRATIONS_DIR);
    return db;
  }

  it("boots an existing DB whose attachments table predates the bound_at column (migration 019)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-upgrade-"));
    const dbPath = path.join(dir, "old.sqlite");
    try {
      // Stand up a realistic PRE-019 database: base tables + the attachments
      // table WITHOUT bound_at/bound_message_id, and schema_migrations stamped
      // through 018 so 019 is the first unapplied migration.
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE fleets (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE attachments (
          id TEXT PRIMARY KEY, fleet_id TEXT NOT NULL, uploader_kind TEXT NOT NULL,
          uploader_id TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL,
          size_bytes INTEGER NOT NULL, storage_path TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      `);
      const stamp = seed.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
      for (let v = 1; v <= 18; v++) stamp.run(v, new Date(0).toISOString());
      seed.close();

      // The exact failure mode was a throw here. Must not throw.
      const db = bootLikeConstructor(dbPath);

      const cols = (db.prepare("PRAGMA table_info(attachments)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain("bound_at");           // migration 019 added it
      expect(cols).toContain("bound_message_id");
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_attachments_bound_created'").get();
      expect(idx).toBeTruthy();                     // and its index
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Migration 025 (relay-observed delivery timing) on the path a real upgrade
// takes. The other 025 tests cover the two halves separately: the ALTERs on
// hand-built tables, and a fresh schema.ts database where the columns already
// exist and the migration is a no-op. Neither boots the relay on a database
// that already holds `agents` and `message_deliveries` in their previous
// shape, where exec(schemaSql) cannot add the columns (CREATE TABLE IF NOT
// EXISTS skips an existing table) and only the migration can. If that path
// broke, the first inbox poll after an upgrade would fail on a missing column.
describe("migration 025 on an existing database, in boot order", () => {
  const ALL_MIGRATIONS = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

  const columns = (db: Database.Database, table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  const versions = (db: Database.Database) =>
    (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map((r) => r.version);

  /**
   * A database as the previous relay build leaves it: the full schema, every
   * migration before 025 applied and stamped, and both tables without the
   * 025 columns. Built from today's schema.ts with the two columns dropped, so
   * every other table, column and index the routes need is real.
   */
  function seedPre025Database(dbPath: string, workDir: string) {
    const before025 = path.join(workDir, "migrations-before-025");
    fs.mkdirSync(before025);
    for (const f of ALL_MIGRATIONS) {
      if (parseInt(f.split("_")[0], 10) < 25) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(before025, f));
    }
    const seed = new Database(dbPath);
    seed.pragma("journal_mode = WAL");
    seed.exec(schemaSql);
    runMigrationsOn(seed, before025);
    seed.exec("ALTER TABLE agents DROP COLUMN last_inbox_poll_at");
    seed.exec("ALTER TABLE message_deliveries DROP COLUMN ack_recorded_at");

    // Rows written before the upgrade: an agent that polled and acked on the
    // previous build, which recorded neither relay-clock time.
    const at = "2026-11-01T00:00:00.000Z";
    seed.prepare("INSERT INTO fleets (id, name, created_at) VALUES (?, ?, ?)").run("flt_old", "pre-025-fleet", at);
    const agent = seed.prepare(
      "INSERT INTO agents (id, fleet_id, display_name, runtime, status, policy_profile, created_at) VALUES (?, 'flt_old', ?, 'custom', 'active', 'default', ?)"
    );
    agent.run("agt_old_sender", "old-sender", at);
    agent.run("agt_old_recipient", "old-recipient", at);
    seed.prepare(
      `INSERT INTO messages (id, fleet_id, conversation_id, correlation_id, sender_agent_id, recipient_kind, recipient_id,
         message_type, priority, body_json, ttl_seconds, created_at, expires_at, status)
       VALUES ('msg_old', 'flt_old', 'conv-old', 'cor-old', 'agt_old_sender', 'agent', 'agt_old_recipient',
         'direct', 'normal', '{"text":"synthetic"}', 3600, ?, '2026-11-01T01:00:00.000Z', 'acked')`
    ).run(at);
    seed.prepare(
      `INSERT INTO message_deliveries (id, message_id, recipient_agent_id, delivery_attempts, queued_at, delivered_at, acked_at, status)
       VALUES ('dlv_old', 'msg_old', 'agt_old_recipient', 1, ?, '2026-11-01T00:00:02.000Z', '2026-11-01T00:00:05.000Z', 'acked')`
    ).run(at);

    const shape = {
      agentColumns: columns(seed, "agents"),
      deliveryColumns: columns(seed, "message_deliveries"),
      versions: versions(seed)
    };
    seed.close();
    return shape;
  }

  it("boots the relay on a pre-025 database that already has agents and message_deliveries, then serves one poll and one ack", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-upgrade-025-"));
    const dbPath = path.join(dir, "pre-025.sqlite");
    const previousDbPath = process.env.EKHO_DB_PATH;
    let relay: Awaited<ReturnType<typeof createTestRelay>> | undefined;
    try {
      const seeded = seedPre025Database(dbPath, dir);
      // The seed really is pre-025: both tables exist, neither has its new
      // column, and 025 is the only migration not yet applied.
      expect(seeded.agentColumns).toContain("peer_turn_budget");
      expect(seeded.agentColumns).not.toContain("last_inbox_poll_at");
      expect(seeded.deliveryColumns).toContain("acked_at");
      expect(seeded.deliveryColumns).not.toContain("ack_recorded_at");
      const expectedBefore = ALL_MIGRATIONS.map((f) => parseInt(f.split("_")[0], 10)).filter((v) => v < 25);
      expect(seeded.versions).toEqual(expectedBefore);
      expect(ALL_MIGRATIONS.some((f) => f.startsWith("025_"))).toBe(true);

      // Boot the real thing on that file. A fresh module graph makes db.ts
      // build its singleton again, so this is the EkhoDb constructor itself
      // (exec(schemaSql), then the migrations) with the real routes on top.
      process.env.EKHO_DB_PATH = dbPath;
      vi.resetModules();
      relay = await createTestRelay();
      const raw = relay.db.raw();
      expect(raw.name).toBe(dbPath);

      // The migration ran, once, and added exactly one of each column.
      expect(versions(raw)).toEqual([...expectedBefore, 25]);
      expect(columns(raw, "agents").filter((c) => c === "last_inbox_poll_at")).toHaveLength(1);
      expect(columns(raw, "message_deliveries").filter((c) => c === "ack_recorded_at")).toHaveLength(1);

      // Pre-upgrade rows survive untouched: no poll time, and the old ack
      // keeps its adapter time with no relay time (nothing is backfilled).
      const oldAgent = raw.prepare("SELECT display_name, last_inbox_poll_at FROM agents WHERE id = 'agt_old_recipient'").get() as
        { display_name: string; last_inbox_poll_at: string | null };
      expect(oldAgent).toEqual({ display_name: "old-recipient", last_inbox_poll_at: null });
      const oldDelivery = raw.prepare("SELECT status, acked_at, ack_recorded_at FROM message_deliveries WHERE id = 'dlv_old'").get() as
        { status: string; acked_at: string; ack_recorded_at: string | null };
      expect(oldDelivery).toEqual({ status: "acked", acked_at: "2026-11-01T00:00:05.000Z", ack_recorded_at: null });

      // One poll and one ack through the routes, on the upgraded database.
      const sender = await relay.enrollAgent("upgrade-sender");
      const recipient = await relay.enrollAgent("upgrade-recipient");
      const sent = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: recipient.agent_id },
        message_type: "direct",
        body: { text: "first message after the upgrade" },
        conversation_id: "upgrade-025",
        correlation_id: "upgrade-025-cor"
      });
      expect(sent.status).toBe(200);
      const messageId = sent.body.message_id as string;

      const beforePoll = Date.now();
      const inbox = await relay.agentRequest(recipient.agent_id, recipient.secret, "GET", "/v1/inbox");
      expect(inbox.status).toBe(200);
      expect(inbox.body.messages.map((m: { message_id: string }) => m.message_id)).toEqual([messageId]);

      const ack = await relay.agentRequest(recipient.agent_id, recipient.secret, "POST", "/v1/acks", {
        acks: [{ message_id: messageId, status: "received", received_at: new Date().toISOString() }]
      });
      expect(ack.status).toBe(200);
      const afterAck = Date.now();

      const within = (iso: unknown) => {
        const t = Date.parse(iso as string);
        expect(t).toBeGreaterThanOrEqual(beforePoll);
        expect(t).toBeLessThanOrEqual(afterAck);
      };
      const health = await relay.operatorRequest("GET", "/v1/operator/fleet-health");
      expect(health.status).toBe(200);
      const row = health.body.agents.find((a: { id: string }) => a.id === recipient.agent_id);
      within(row.last_inbox_poll_at);

      const status = await relay.agentRequest(sender.agent_id, sender.secret, "GET", `/v1/messages/${messageId}/status`);
      expect(status.status).toBe(200);
      const [delivery] = status.body.deliveries;
      expect(delivery.status).toBe("acked");
      within(delivery.ack_recorded_at);

      // The new writes landed only on the rows that polled and acked.
      const untouched = raw.prepare("SELECT ack_recorded_at FROM message_deliveries WHERE id = 'dlv_old'").get() as { ack_recorded_at: string | null };
      expect(untouched.ack_recorded_at).toBeNull();
    } finally {
      relay?.cleanup();
      relay?.db.raw().close();
      if (previousDbPath === undefined) delete process.env.EKHO_DB_PATH;
      else process.env.EKHO_DB_PATH = previousDbPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
