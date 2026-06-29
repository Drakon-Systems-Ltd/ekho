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
});
