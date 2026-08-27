import "./setup"; // sets a temp EKHO_DB_PATH before db.ts's singleton is created
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { applyMigration, runMigrationsOn } from "../src/db";
import { schemaSql } from "../src/schema";

const REAL_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

function freshDb() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER)");
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  return db;
}
const versions = (db: Database.Database) =>
  (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map((r) => r.version);
const hasColumn = (db: Database.Database, table: string, col: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
const tableExists = (db: Database.Database, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

// M6 — each migration file + its version-record must apply ATOMICALLY: a file
// that fails partway rolls back fully and records no version; the idempotent
// duplicate-column path is preserved per-statement.
describe("transactional migrations (M6)", () => {
  it("applies a good migration and records its version atomically", () => {
    const db = freshDb();
    applyMigration(db, 100, "ALTER TABLE t ADD COLUMN newcol INTEGER; CREATE INDEX IF NOT EXISTS ix ON t(newcol);", "2026-06-11T00:00:00.000Z");
    expect(hasColumn(db, "t", "newcol")).toBe(true);
    expect(versions(db)).toEqual([100]);
    expect(db.inTransaction).toBe(false);
  });

  it("rolls back fully and records NO version when a statement fails", () => {
    const db = freshDb();
    expect(() =>
      applyMigration(db, 101, "ALTER TABLE t ADD COLUMN good INTEGER; CREATE TABLE oops (this is not valid sql", "2026-06-11T00:00:00.000Z")
    ).toThrow();
    expect(hasColumn(db, "t", "good")).toBe(false); // earlier valid ALTER rolled back
    expect(tableExists(db, "oops")).toBe(false);
    expect(versions(db)).not.toContain(101);
    expect(db.inTransaction).toBe(false);
  });

  it("swallows a duplicate-column statement but still commits the rest + the version", () => {
    const db = freshDb();
    db.exec("ALTER TABLE t ADD COLUMN dupe INTEGER"); // pre-existing column
    applyMigration(db, 102, "ALTER TABLE t ADD COLUMN dupe INTEGER; ALTER TABLE t ADD COLUMN fresh INTEGER;", "2026-06-11T00:00:00.000Z");
    expect(hasColumn(db, "t", "fresh")).toBe(true);
    expect(versions(db)).toContain(102);
  });

  it("does not record a version when a later statement fails after an earlier one succeeded", () => {
    const db = freshDb();
    expect(() =>
      applyMigration(db, 103, "CREATE TABLE a103 (x INTEGER); INSERT INTO nonexistent_table VALUES (1);", "2026-06-11T00:00:00.000Z")
    ).toThrow();
    expect(tableExists(db, "a103")).toBe(false); // rolled back
    expect(versions(db)).not.toContain(103);
  });

  it("runMigrationsOn is idempotent across re-runs", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE base (id INTEGER)");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-migr-"));
    fs.writeFileSync(path.join(dir, "001_add.sql"), "ALTER TABLE base ADD COLUMN c1 INTEGER;");
    fs.writeFileSync(path.join(dir, "002_idx.sql"), "CREATE INDEX IF NOT EXISTS ix1 ON base(c1);");

    runMigrationsOn(db, dir);
    expect(versions(db)).toEqual([1, 2]);
    expect(hasColumn(db, "base", "c1")).toBe(true);

    runMigrationsOn(db, dir); // second run — no-op
    expect(versions(db)).toEqual([1, 2]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Boot-critical: the REAL migration files must apply atomically on a fresh
  // schema.ts DB (the actual cold-boot path), and be a byte-for-byte no-op on a
  // DB already at the latest version (the live tars relay). This guards the
  // naive ';' split against a future migration that adds a trigger / quoted ';'.
  it("applies the real migrations/ files on a fresh schema.ts DB and is a no-op when already current", () => {
    const db = new Database(":memory:");
    db.exec(schemaSql); // mirror EkhoDb's constructor: schema first, then migrations
    runMigrationsOn(db, REAL_MIGRATIONS_DIR);

    const applied = versions(db);
    expect(applied.length).toBeGreaterThanOrEqual(14);
    // versions are contiguous from 1 and the agents table has migration-added cols
    expect(applied[0]).toBe(1);
    expect(hasColumn(db, "agents", "operator_trusted")).toBe(true);
    expect(db.inTransaction).toBe(false);

    // already-current DB → zero new statements, identical version set
    const before = versions(db);
    runMigrationsOn(db, REAL_MIGRATIONS_DIR);
    expect(versions(db)).toEqual(before);
  });

  // Peer auto-reply ON by default: migration 015 flips the existing live fleet on
  // (peer_autoreply 0 -> 1) while leaving already-on agents untouched.
  it("migration 015 flips existing peer_autoreply=0 rows to 1", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    // Simulate a legacy DB: the column was created DEFAULT 0 by migration 009.
    db.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, peer_autoreply INTEGER NOT NULL DEFAULT 0)");
    db.exec("INSERT INTO agents (id, peer_autoreply) VALUES ('a', 0), ('b', 0), ('c', 1)");
    // A legacy DB also has the rooms table (migration 010) — needed so the later
    // migration 016 (ALTER TABLE rooms) applies cleanly when runMigrationsOn runs
    // every migration after 014.
    db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, fleet_id TEXT, name TEXT, created_at TEXT, created_by_operator_id TEXT)");
    // …and the operators table (migration 001) so migration 018 (ALTER TABLE
    // operators ADD COLUMN display_name) applies cleanly too.
    db.exec("CREATE TABLE operators (id TEXT PRIMARY KEY, fleet_id TEXT, email TEXT, password_hash TEXT, role TEXT, created_at TEXT)");
    // …and the attachments table (migration 008) so migration 019 (ALTER TABLE
    // attachments ADD COLUMN bound_message_id/bound_at) applies cleanly too.
    db.exec("CREATE TABLE attachments (id TEXT PRIMARY KEY, fleet_id TEXT, uploader_kind TEXT, uploader_id TEXT, filename TEXT, mime TEXT, size_bytes INTEGER, storage_path TEXT, created_at TEXT)");
    // …and the a2a tables (migration 005) plus messages (migration 001) so
    // migration 020 (ALTER TABLE a2a_tasks ADD COLUMN sender_agent_id, then a
    // backfill that joins through a2a_task_messages to messages) applies cleanly.
    db.exec("CREATE TABLE a2a_tasks (id TEXT PRIMARY KEY, fleet_id TEXT, agent_id TEXT, context_id TEXT, state TEXT, history_json TEXT, artifacts_json TEXT, metadata_json TEXT, created_at TEXT, updated_at TEXT)");
    db.exec("CREATE TABLE a2a_task_messages (task_id TEXT, message_id TEXT, PRIMARY KEY (task_id, message_id))");
    db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, fleet_id TEXT, sender_agent_id TEXT, created_at TEXT)");
    // Mark every migration through 014 as applied so runMigrationsOn runs 015+.
    const mark = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
    for (let v = 1; v <= 14; v++) mark.run(v, "2026-06-28T00:00:00.000Z");

    runMigrationsOn(db, REAL_MIGRATIONS_DIR);

    const rows = db.prepare("SELECT id, peer_autoreply FROM agents ORDER BY id").all();
    expect(rows).toEqual([
      { id: "a", peer_autoreply: 1 }, // flipped on
      { id: "b", peer_autoreply: 1 }, // flipped on
      { id: "c", peer_autoreply: 1 }  // already on, unchanged
    ]);
    expect(versions(db)).toContain(15);
  });

  // #58 — migration 020 adds a2a_tasks.sender_agent_id, the column the A2A
  // task-scoping check reads. On an upgraded relay the existing tasks must
  // recover their owner from the Ekho message they were linked to, or every
  // in-flight task would become invisible to the agent that created it.
  it("migration 020 backfills a2a_tasks.sender_agent_id from the linked message", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    db.exec(`
      CREATE TABLE a2a_tasks (
        id TEXT PRIMARY KEY, fleet_id TEXT, agent_id TEXT, context_id TEXT, state TEXT,
        history_json TEXT, artifacts_json TEXT, metadata_json TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE a2a_task_messages (task_id TEXT, message_id TEXT, PRIMARY KEY (task_id, message_id));
      CREATE TABLE messages (id TEXT PRIMARY KEY, fleet_id TEXT, sender_agent_id TEXT, created_at TEXT);
    `);
    db.exec(`
      INSERT INTO a2a_tasks (id, fleet_id, agent_id, context_id, state, history_json, artifacts_json, created_at, updated_at)
      VALUES ('task_linked', 'flt_1', 'agent_recipient', 'ctx_1', 'submitted', '[]', '[]', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
             ('task_orphan', 'flt_1', 'agent_recipient', 'ctx_2', 'submitted', '[]', '[]', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
      INSERT INTO messages (id, fleet_id, sender_agent_id, created_at)
      VALUES ('msg_first', 'flt_1', 'agent_creator', '2026-06-01T00:00:00.000Z'),
             ('msg_later', 'flt_1', 'agent_replier', '2026-06-02T00:00:00.000Z');
      INSERT INTO a2a_task_messages (task_id, message_id) VALUES ('task_linked', 'msg_first'), ('task_linked', 'msg_later');
    `);
    // Only 020 is unapplied.
    const mark = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
    for (let v = 1; v <= 19; v++) mark.run(v, "2026-06-28T00:00:00.000Z");

    runMigrationsOn(db, REAL_MIGRATIONS_DIR);

    expect(hasColumn(db, "a2a_tasks", "sender_agent_id")).toBe(true);
    const rows = db.prepare("SELECT id, sender_agent_id FROM a2a_tasks ORDER BY id").all();
    expect(rows).toEqual([
      // Recovered from the EARLIEST linked message — the one that created it.
      { id: "task_linked", sender_agent_id: "agent_creator" },
      // No link to recover from: stays NULL, which matches no caller (fail closed).
      { id: "task_orphan", sender_agent_id: null }
    ]);
    expect(versions(db)).toContain(20);
  });
});
