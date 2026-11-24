import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// #196 R1: every event type the relay writes must be classified as pruned
// (PRUNABLE_EVENT_TYPES) or retained forever (RETAINED_FOREVER, below). Static
// text scan of db.ts only: db.ts is never imported, so no database is opened and no
// rows are touched. PRUNABLE_EVENT_TYPES is read from the source text too.

// Records TODAY'S behaviour, not a decision that it is right. `message.delivered`
// is written by a direct INSERT in the inbox path and is not in the allowlist,
// so it is kept forever; nothing in the code says that was chosen (see #196).
const RETAINED_FOREVER: ReadonlySet<string> = new Set([
  "operator_key.registered", "operator_key.endorsed", "operator_key.revoked",
  "operator_key.recovery_grant_armed", "operator_key.recovery_grant_cancelled",
  "operator_key.recovery_grant_consumed", "agent_key.endorsed",
  "message.delivered", "message.expired", "message.retry_requeued", "message.dead_lettered",
  "attachment.uploaded", "approval.requested", "approval.result",
  "agent.trust_changed", "agent.peer_autoreply_changed",
  "agent.auto_quarantined", "agent.auto_unquarantined",
  "room.created", "room.deleted", "feed.created", "feed.deleted", "feed.subscribers_changed",
  "policy.created", "policy.updated", "policy.deleted"
]);
// Template types, matched by prefix and retained: agent.${action}, approval.${status}.
const RETAINED_TEMPLATE_PREFIXES = ["agent.", "approval."];


/** Blank out comments, leaving string/template literals intact. */
function stripComments(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; ) {
    const c = s[i], n = s[i + 1];
    if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i = s.indexOf("*/", i + 2) + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === "\\" ? 2 : 1;
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

/** Top-level comma-separated arguments of the call whose "(" is at `open`. */
function args(code: string, open: number): string[] {
  const res: string[] = []; let depth = 0, cur = "";
  for (let i = open + 1; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      cur += code.slice(i, j + 1); i = j; continue;
    }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) { if (depth === 0) { res.push(cur.trim()); return res; } depth--; }
    if (c === "," && depth === 0) { res.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  throw new Error("unterminated call");
}

const dbSource = fs.readFileSync(path.join(__dirname, "..", "src", "db.ts"), "utf8");
const PRUNABLE_EVENT_TYPES: ReadonlySet<string> = (() => {
  const m = /export const PRUNABLE_EVENT_TYPES[^=]*=\s*new Set\(\[([^\]]*)\]/.exec(stripComments(dbSource));
  if (!m) throw new Error("PRUNABLE_EVENT_TYPES literal not found in db.ts: update this test.");
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
})();

const isPruned = (t: string) => PRUNABLE_EVENT_TYPES.has(t) || RETAINED_FOREVER.has(t);

/** Returns a list of problems; empty means the source is fully classified. */
function analyse(source: string): string[] {
  const code = stripComments(source);
  const problems: string[] = [];
  const sites: string[] = [];
  for (const m of code.matchAll(/this\.recordEvent\(/g)) sites.push(args(code, m.index! + m[0].length - 1)[1]);
  for (const m of code.matchAll(/const (\w+) = this\.db\.prepare\(\s*"INSERT INTO events/g)) {
    for (const r of code.matchAll(new RegExp(`\\b${m[1]}\\.run\\(`, "g"))) {
      const type = args(code, r.index! + r[0].length - 1)[2];
      if (type !== "eventType") sites.push(type);
    }
  }
  for (const arg of sites) {
    if (/^"[^"]*"$/.test(arg)) { if (!isPruned(arg.slice(1, -1))) problems.push(`unclassified ${arg}`); }
    else if (/^`[^`$]*\$\{[^}]+\}`$/.test(arg)) {
      if (!RETAINED_TEMPLATE_PREFIXES.includes(arg.slice(1, arg.indexOf("${")))) problems.push(`template ${arg}`);
    } else problems.push(`unrecognised ${arg}`);
  }
  const calls = (code.match(/recordEvent\(/g) ?? []).length - 1;
  const inserts = (code.match(/INSERT INTO events/g) ?? []).length - 1;
  if (sites.length !== calls + inserts) problems.push("site count mismatch");
  return problems;
}

const src = dbSource;

// Synthetic fixtures. Not real code: they exercise the scanner's claimed coverage.
const FIX_BASE = `
class F {
  controlAgent(action: "pause" | "resume") {
    this.recordEvent("f", \`agent.\${action}\`, "operator", "o", "agent", "a", "", {});
  }
  deliver() {
    const eventStmt = this.db.prepare("INSERT INTO events (id, event_type) VALUES (?, ?)");
    eventStmt.run("i", "f", "message.delivered");
  }
  recordEvent(fleetId: string, eventType: string) {
    this.db.prepare("INSERT INTO events (id, event_type) VALUES (?, ?)").run("i", eventType);
  }
}`;

describe("#196 R1: scanner fixtures (synthetic source)", () => {
  it("F0: baseline fixture is accepted", () => {
    expect(analyse(FIX_BASE)).toEqual([]);
  });
  it("F1: widening a template domain is rejected", () => {
    const widened = FIX_BASE.replace('"pause" | "resume"', '"pause" | "resume" | "wipe"');
    expect(analyse(widened).length).toBeGreaterThan(0);
  });
  it("F2: a second run of one prepared insert cannot mask a missed insert elsewhere", () => {
    // stmt3 is prepared with a template literal, a spelling the scan does not read as a prepared insert.
    const masked = FIX_BASE
      .replace('eventStmt.run("i", "f", "message.delivered");', 'eventStmt.run("i", "f", "message.delivered");\n    eventStmt.run("i", "f", "message.delivered");')
      .replace("class F {", "class F {\n  other() { const stmt3 = this.db.prepare(`INSERT INTO events (id, event_type) VALUES (?, ?)`); stmt3.run(\"i\", \"f\", \"brand.new\"); }");
    expect(analyse(masked).length).toBeGreaterThan(0);
  });
  it("F3: an insert in an unscanned spelling is rejected", () => {
    const odd = FIX_BASE.replace("class F {", 'class F {\n  sneaky() { this.db.prepare("insert into events (id, event_type) values (?, ?)").run("i", "f", "brand.new"); }');
    expect(analyse(odd).length).toBeGreaterThan(0);
  });
});

describe("#196 R1: event type retention classification (real db.ts)", () => {
  it("T1: db.ts is fully classified", () => {
    expect(analyse(src)).toEqual([]);
  });
  it("T4: message.delivered is recorded as retained forever (today's behaviour, see #196)", () => {
    expect(RETAINED_FOREVER.has("message.delivered")).toBe(true);
    expect(PRUNABLE_EVENT_TYPES.has("message.delivered")).toBe(false);
  });
});
