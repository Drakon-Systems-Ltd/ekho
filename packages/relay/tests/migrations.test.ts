import "./setup"; // sets a temp EKHO_DB_PATH before db.ts's singleton is created
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { applyMigration, runMigrationsOn } from "../src/db";

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
});
