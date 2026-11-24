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
  "policy.created", "policy.updated", "policy.deleted",
  // Concrete names of the two template types, resolved below (EXPECTED_TEMPLATE_DOMAINS).
  "approval.approved", "approval.rejected",
  "agent.pause", "agent.resume", "agent.quarantine"
]);

// The two template event types and the finite union each is built from, as the
// test expects them today. The scan reads the union out of the method signature
// and requires an EXACT match: widening (or narrowing) a union fails here until
// the new concrete name is classified and listed. Fail closed, by design.
const EXPECTED_TEMPLATE_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  "agent.${action}": ["agent.pause", "agent.resume", "agent.quarantine"],
  "approval.${status}": ["approval.approved", "approval.rejected"]
};


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

const isClassified = (t: string) => PRUNABLE_EVENT_TYPES.has(t) || RETAINED_FOREVER.has(t);

const INSERT_RE = /insert\s+(?:or\s+\w+\s+)?into\s+events\b/gi;
const PREPARED_RE = /const (\w+) = this\.db\.prepare\(\s*"$/;

/** Offset one past the "}" that closes the block containing `from`. */
function blockEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      i = j; continue;
    }
    if (c === "{") depth++;
    if (c === "}") { if (depth === 0) return i; depth--; }
  }
  return code.length;
}

type Analysis = { problems: string[]; written: Set<string>; insertStatements: number; executions: Record<string, number> };

/**
 * Identity-based scan. Every `INSERT INTO events` spelling is a statement site;
 * each must be one of two recognised forms, and each is verified on its own:
 *   - inline in recordEvent: `.run(id, fleet, eventType, ...)` inside recordEvent();
 *   - prepared: `const X = this.db.prepare("INSERT INTO events ...")`, then EVERY
 *     `X.run(...)` in the same block carries a classified literal type, and X
 *     is run at least once.
 * Every recordEvent call is `this.recordEvent(...)` with a literal type or a
 * template whose union is resolved to concrete names and matched to the
 * expectation. Scope: the single source string passed in.
 */
function analyse(
  source: string,
  domains: Readonly<Record<string, readonly string[]>> = EXPECTED_TEMPLATE_DOMAINS
): Analysis {
  const code = stripComments(source);
  const problems: string[] = [];
  const written = new Set<string>();
  const executions: Record<string, number> = {};
  const note = (name: string, where: string) => {
    written.add(name);
    if (!isClassified(name)) problems.push(`${where}: event type ${name} is in neither PRUNABLE_EVENT_TYPES nor RETAINED_FOREVER (classify it deliberately, #196).`);
  };

  // 1. Insert statements, by site.
  const stmts = [...code.matchAll(INSERT_RE)];
  const recordEventDef = /(^|\n)\s*recordEvent\(/.exec(code);
  const defStart = recordEventDef ? recordEventDef.index + recordEventDef[0].length : -1;
  const defEnd = defStart < 0 ? -1 : blockEnd(code, code.indexOf("{", defStart));
  for (const m of stmts) {
    const at = m.index!;
    const before = code.slice(Math.max(0, at - 160), at);
    const prepared = PREPARED_RE.exec(before);
    if (prepared) {
      const v = prepared[1];
      const scopeEnd = blockEnd(code, at);
      const scope = code.slice(at, scopeEnd);
      const runs = [...scope.matchAll(new RegExp(`\\b${v}\\.run\\(`, "g"))];
      executions[`${v}@${at}`] = runs.length;
      if (runs.length === 0) problems.push(`prepared insert ${v} at offset ${at} is never run in its block.`);
      for (const r of runs) {
        const type = args(scope, r.index! + r[0].length - 1)[2];
        if (type !== undefined && /^"[^"]*"$/.test(type)) note(type.slice(1, -1), `${v}.run at offset ${at + r.index!}`);
        else problems.push(`${v}.run at offset ${at + r.index!}: event type argument ${type} is not a string literal; extend the scanner and classify it.`);
      }
    } else if (defStart >= 0 && at > defStart && at < defEnd) {
      const strEnd = code.indexOf('"', at);
      const tail = code.slice(strEnd + 1);
      const call = /^\s*\)\s*\.run\(/.exec(tail);
      const type = call ? args(code, strEnd + 1 + call[0].length - 1)[2] : undefined;
      if (type === "eventType") executions[`recordEvent@${at}`] = 1;
      else problems.push(`inline insert in recordEvent at offset ${at}: expected .run(..., eventType, ...) but found ${type}.`);
    } else {
      problems.push(`unrecognised INSERT INTO events spelling at offset ${at}: the scan cannot see its event type. Extend the scanner or use recordEvent.`);
    }
  }

  // 2. recordEvent calls and any other reference.
  for (const m of code.matchAll(/\brecordEvent\b/g)) {
    const at = m.index!;
    const isThisCall = code.slice(at - 5, at) === "this." && code[at + m[0].length] === "(";
    const isDef = recordEventDef !== null && at === defStart - "recordEvent(".length;
    if (isDef) continue;
    if (!isThisCall) { problems.push(`recordEvent referenced at offset ${at} other than as this.recordEvent(...): the scan cannot follow it.`); continue; }
    const arg = args(code, at + m[0].length)[1];
    if (arg !== undefined && /^"[^"]*"$/.test(arg)) { note(arg.slice(1, -1), `recordEvent at offset ${at}`); continue; }
    const t = arg !== undefined ? /^`([^`$]*)\$\{(\w+)\}`$/.exec(arg) : null;
    if (!t) { problems.push(`recordEvent at offset ${at}: unrecognised event type expression ${arg}.`); continue; }
    const key = `${t[1]}\${${t[2]}}`;
    const union = [...code.slice(0, at).matchAll(new RegExp(`\\b${t[2]}\\s*:\\s*((?:"[^"]*"\\s*\\|\\s*)*"[^"]*")`, "g"))].pop();
    const names = union ? [...union[1].matchAll(/"([^"]*)"/g)].map((x) => t[1] + x[1]) : null;
    const expected = domains[key];
    if (!names) { problems.push(`recordEvent at offset ${at}: could not resolve the domain of ${t[2]} for ${key}; the type is no longer a finite string union.`); continue; }
    if (!expected) { problems.push(`recordEvent at offset ${at}: template ${key} is not in EXPECTED_TEMPLATE_DOMAINS.`); continue; }
    if (JSON.stringify([...names].sort()) !== JSON.stringify([...expected].sort())) {
      problems.push(`recordEvent at offset ${at}: ${key} resolves to [${names.join(", ")}] but the test expects [${expected.join(", ")}]. Classify the change, then update EXPECTED_TEMPLATE_DOMAINS and RETAINED_FOREVER.`);
    }
    for (const n of names) note(n, `recordEvent at offset ${at}`);
  }
  return { problems, written, insertStatements: stmts.length, executions };
}

const src = dbSource;

// Synthetic fixtures. Not real code: they exercise the scanner's claimed coverage.
const FIX_DOMAINS = { "agent.${action}": ["agent.pause", "agent.resume"] };
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
    this.db.prepare("INSERT INTO events (id, event_type) VALUES (?, ?)").run("i", "f", eventType);
  }
}`;

describe("#196 R1: scanner fixtures (synthetic source)", () => {
  it("F0: baseline fixture is accepted", () => {
    expect(analyse(FIX_BASE, FIX_DOMAINS).problems).toEqual([]);
  });
  it("F1: widening a template domain is rejected", () => {
    const widened = FIX_BASE.replace('"pause" | "resume"', '"pause" | "resume" | "wipe"');
    expect(analyse(widened, FIX_DOMAINS).problems.length).toBeGreaterThan(0);
  });
  it("F2: a second run of one prepared insert cannot mask a missed insert elsewhere", () => {
    // stmt3 is prepared with a template literal, a spelling the scan does not read as a prepared insert.
    const masked = FIX_BASE
      .replace('eventStmt.run("i", "f", "message.delivered");', 'eventStmt.run("i", "f", "message.delivered");\n    eventStmt.run("i", "f", "message.delivered");')
      .replace("class F {", "class F {\n  other() { const stmt3 = this.db.prepare(`INSERT INTO events (id, event_type) VALUES (?, ?)`); stmt3.run(\"i\", \"f\", \"brand.new\"); }");
    expect(analyse(masked, FIX_DOMAINS).problems.length).toBeGreaterThan(0);
  });
  it("F3: an insert in an unscanned spelling is rejected", () => {
    const odd = FIX_BASE.replace("class F {", 'class F {\n  sneaky() { this.db.prepare("insert into events (id, event_type) values (?, ?)").run("i", "f", "brand.new"); }');
    expect(analyse(odd, FIX_DOMAINS).problems.length).toBeGreaterThan(0);
  });
});

describe("#196 R1: event type retention classification (real db.ts)", () => {
  const real = analyse(src);

  it("T1: every event type db.ts writes is pruned or retained forever", () => {
    expect(real.problems).toEqual([]);
  });

  it("T2: template domains resolve to the listed concrete names, all retained", () => {
    const concrete = Object.values(EXPECTED_TEMPLATE_DOMAINS).flat().sort();
    expect(concrete).toEqual(["agent.pause", "agent.quarantine", "agent.resume", "approval.approved", "approval.rejected"]);
    for (const n of concrete) {
      expect(real.written.has(n), `${n} resolved from the source`).toBe(true);
      expect(RETAINED_FOREVER.has(n)).toBe(true);
      expect(PRUNABLE_EVENT_TYPES.has(n)).toBe(false);
    }
  });

  it("T3: lists are disjoint and every listed type is actually written", () => {
    expect([...RETAINED_FOREVER].filter((t) => PRUNABLE_EVENT_TYPES.has(t))).toEqual([]);
    expect([...PRUNABLE_EVENT_TYPES].filter((t) => !real.written.has(t))).toEqual([]);
    expect([...RETAINED_FOREVER].filter((t) => !real.written.has(t)), "RETAINED_FOREVER lists a type nothing writes").toEqual([]);
  });

  it("T4: message.delivered is recorded as retained forever (today's behaviour, see #196)", () => {
    expect(RETAINED_FOREVER.has("message.delivered")).toBe(true);
    expect(PRUNABLE_EVENT_TYPES.has("message.delivered")).toBe(false);
  });

  it("T5: the two known insert statements are each verified; no other spelling or file writes events", () => {
    // Exactly the statements seen today: the one in recordEvent and the prepared one in the inbox path.
    expect(real.insertStatements).toBe(2);
    expect(Object.keys(real.executions).sort().map((k) => k.split("@")[0])).toEqual(["eventStmt", "recordEvent"]);
    for (const [k, n] of Object.entries(real.executions)) expect(n, k).toBeGreaterThan(0);
    // No other relay source file writes events or calls recordEvent.
    const srcDir = path.join(__dirname, "..", "src");
    const others: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.[cm]?[jt]sx?$/.test(e.name) && path.resolve(f) !== path.resolve(srcDir, "db.ts")) {
          const c = stripComments(fs.readFileSync(f, "utf8"));
          if (/into\s+events\b|\brecordEvent\b/i.test(c)) others.push(path.relative(srcDir, f));
        }
      }
    };
    walk(srcDir);
    expect(others, "event writes outside db.ts are not scanned: extend the scan").toEqual([]);
  });
});
