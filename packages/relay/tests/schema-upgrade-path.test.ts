import { describe, it, expect } from "vitest";
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
