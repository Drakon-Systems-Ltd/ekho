import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { schemaSql } from "../src/schema";

// #196 H2: the relay announces, at boot, which missing indexes the schema step
// is about to build and how long the step took. NOTE: this file must NOT import
// ./setup. T7 needs the first load of ../src/db to happen here, after the
// database at EKHO_DB_PATH has been prepared and console.log is spied.

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const ISSUE_196_INDEXES = ["idx_events_resource", "idx_events_fleet_conversation"];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-boot-index-"));
const bootDbPath = path.join(tmpDir, "boot.sqlite");

// Only the environment config.ts needs, copied from setup.ts.
process.env.EKHO_DB_PATH = bootDbPath;
process.env.EKHO_OPERATOR_SESSION_SECRET = "test-secret";

/** A database that ran the full schema and every migration, then lost the two #196 indexes. */
function seedDroppedIndexes(dbPath: string) {
  const seed = new Database(dbPath);
  seed.exec(schemaSql);
  seed.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const stamp = seed.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)");
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql"))) {
    stamp.run(parseInt(f.split("_")[0], 10), "2026-01-01T00:00:00.000Z");
  }
  for (const name of ISSUE_196_INDEXES) seed.exec(`DROP INDEX ${name}`);
  seed.close();
}

function freshDb(name: string, withSchema: boolean, dropIssueIndexes = false) {
  const db = new Database(path.join(tmpDir, name));
  if (withSchema) db.exec(schemaSql);
  if (dropIssueIndexes) for (const n of ISSUE_196_INDEXES) db.exec(`DROP INDEX ${n}`);
  return db;
}

function indexNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
}

let mod: typeof import("../src/db");
let bootLines: string[] = [];

beforeAll(async () => {
  seedDroppedIndexes(bootDbPath);
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    bootLines.push(args.join(" "));
  });
  try {
    mod = await import("../src/db"); // first load of db.ts in this file: runs the EkhoDb constructor
  } finally {
    spy.mockRestore();
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("missingSchemaIndexes", () => {
  it("T1: reports exactly the two dropped #196 indexes, both on events", () => {
    const db = freshDb("t1.sqlite", true, true);
    const missing = mod.missingSchemaIndexes(db, schemaSql);
    expect(missing.map((m) => m.name).sort()).toEqual([...ISSUE_196_INDEXES].sort());
    expect(missing.every((m) => m.table === "events")).toBe(true);
    db.close();
  });

  it("T2: an empty database reports nothing (no table exists yet)", () => {
    const db = freshDb("t2.sqlite", false);
    expect(mod.missingSchemaIndexes(db, schemaSql)).toEqual([]);
    db.close();
  });

  it("T3: a fully booted database reports nothing", () => {
    const db = freshDb("t3.sqlite", true);
    expect(mod.missingSchemaIndexes(db, schemaSql)).toEqual([]);
    db.close();
  });
});

describe("execSchemaLogged", () => {
  it("T4: announces before the build, reports elapsed ms after, and builds the indexes", () => {
    const db = freshDb("t4.sqlite", true, true);
    const ticks = [1000, 4500];
    const calls: string[] = [];
    let firstCallSawIndexes: string[] | null = null;
    mod.execSchemaLogged(db, schemaSql, {
      now: () => ticks.shift() as number,
      log: (line) => {
        if (calls.length === 0) firstCallSawIndexes = indexNames(db);
        calls.push(line);
      }
    });
    expect(calls).toHaveLength(2);
    for (const name of ISSUE_196_INDEXES) expect(calls[0]).toContain(name);
    expect(calls[0]).toContain("events");
    expect(firstCallSawIndexes).not.toBeNull();
    for (const name of ISSUE_196_INDEXES) expect(firstCallSawIndexes).not.toContain(name);
    expect(calls[1]).toContain("3500 ms");
    for (const name of ISSUE_196_INDEXES) expect(indexNames(db)).toContain(name);
    db.close();
  });

  it("T5: logs nothing when nothing is missing, and still creates the tables", () => {
    for (const [file, withSchema] of [["t5a.sqlite", false], ["t5b.sqlite", true]] as const) {
      const db = freshDb(file, withSchema);
      const log = vi.fn();
      mod.execSchemaLogged(db, schemaSql, { log, now: () => 0 });
      expect(log).not.toHaveBeenCalled();
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
      expect(tables).toContain("events");
      db.close();
    }
  });
});

describe("parser guard", () => {
  it("T6: the helper sees every non-comment CREATE INDEX in schemaSql, and each exists after boot", () => {
    const declared = schemaSql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .match(/CREATE\s+(?:UNIQUE\s+)?INDEX\b/gi)?.length ?? 0;
    expect(declared).toBeGreaterThan(0);

    const db = freshDb("t6.sqlite", true);
    const dropped = indexNames(db).filter((n) => !n.startsWith("sqlite_autoindex_"));
    for (const n of dropped) db.exec(`DROP INDEX "${n}"`);
    const missing = mod.missingSchemaIndexes(db, schemaSql);
    expect(missing).toHaveLength(declared);

    mod.execSchemaLogged(db, schemaSql, { log: () => {}, now: () => 0 });
    const after = indexNames(db);
    for (const m of missing) expect(after).toContain(m.name);
    db.close();
  });
});

describe("constructor wiring", () => {
  it("T7: loading db.ts on a T1-shaped database logs the building line", () => {
    const building = bootLines.filter((l) => l.startsWith("[ekho-relay] boot:"));
    expect(building.length).toBeGreaterThanOrEqual(1);
    for (const name of ISSUE_196_INDEXES) expect(building[0]).toContain(name);
  });
});
