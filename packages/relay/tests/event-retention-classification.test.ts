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

/** Top-level comma-separated items of the list whose "(" is at `open`, and the offset of its ")". */
function parseList(code: string, open: number): { items: string[]; close: number } {
  const items: string[] = []; let depth = 0, cur = "";
  for (let i = open + 1; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      cur += code.slice(i, j + 1); i = j; continue;
    }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) { if (depth === 0) { if (cur.trim() !== "") items.push(cur.trim()); return { items, close: i }; } depth--; }
    if (c === "," && depth === 0) { items.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  throw new Error("unterminated call");
}
const args = (code: string, open: number): string[] => parseList(code, open).items;


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

type Method = { name: string; open: number; params: string[]; bodyStart: number; bodyEnd: number };
const NOT_METHODS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "else", "do", "try"]);

/** Methods: a line-start `name(params)` followed by an optional `: ReturnType` and `{`. Parameter lists are split at top level. */
function methods(code: string): Method[] {
  const out: Method[] = [];
  for (const m of code.matchAll(/(?:^|\n)[ \t]*(?:(?:public|private|protected|static|async|readonly)\s+)*(\w+)\s*\(/g)) {
    if (NOT_METHODS.has(m[1])) continue;
    const open = m.index! + m[0].length - 1;
    const { items, close } = parseList(code, open);
    const hdr = /^\s*(?::\s*[^{;=]*?)?\s*\{/.exec(code.slice(close + 1));
    if (!hdr) continue;
    const bodyStart = close + 1 + hdr[0].length;
    out.push({ name: m[1], open, params: items, bodyStart, bodyEnd: blockEnd(code, bodyStart) });
  }
  return out;
}

/** Whole declared type text of parameter `name` in method `m`; undefined when `name?:`, destructured or absent. */
const paramType = (m: Method, name: string): string | undefined =>
  m.params.map((p) => /^(\w+)\s*:\s*([\s\S]+)$/.exec(p)).find((x) => x && x[1] === name)?.[2].trim();
const IS_LITERAL_UNION = /^"[^"]*"(?:\s*\|\s*"[^"]*")*$/;

/** Column index of event_type in an `INSERT INTO events (cols) VALUES (?, ...)` text, or an error. */
function eventTypeColumn(sql: string): { idx: number; cols: number } | string {
  const b = /^insert\s+(?:or\s+\w+\s+)?into\s+events\s*\(([^)]*)\)\s*values\s*\(([^)]*)\)\s*$/i.exec(sql);
  if (!b) return "no `(columns) VALUES (...)` list in the recognised shape";
  const cols = b[1].split(",").map((s) => s.trim()), vals = b[2].split(",").map((s) => s.trim());
  if (cols.filter((c) => c === "event_type").length !== 1) return "event_type must appear exactly once in the column list";
  if (!vals.every((v) => v === "?")) return "every VALUES entry must be a bare ?";
  if (vals.length !== cols.length) return `${vals.length} placeholders for ${cols.length} columns`;
  return { idx: cols.indexOf("event_type"), cols: cols.length };
}

type Analysis = { problems: string[]; written: Set<string>; insertStatements: number; executions: Record<string, number> };

/**
 * Text scan, fail closed. Every `INSERT INTO events` spelling is a statement site;
 * each must be one of two recognised forms and its column list, VALUES list and
 * .run argument count must agree, with the event type read at the event_type column:
 *   - inline in recordEvent: `.run(...)` binding `eventType`, which must be recordEvent's second parameter;
 *   - prepared: `const X = this.db.prepare("INSERT INTO events ...")`; every `X.run(...)`
 *     from the end of the SQL literal to the end of the enclosing block carries a classified
 *     literal type; X is run at least once there.
 * Every recordEvent call is `this.recordEvent(...)` with a literal type, or a template
 * `prefix${name}` where `name` is a parameter of the calling method whose WHOLE type is a union
 * of string literals; that union must equal the expectation. Scope: the single source string passed in.
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
  const ms = methods(code);
  const rm = ms.find((x) => x.name === "recordEvent");
  const enclosing = (at: number) => ms.filter((x) => at > x.bodyStart && at < x.bodyEnd).sort((a, b) => b.bodyStart - a.bodyStart)[0];

  // 1. Insert statements, by site.
  const stmts = [...code.matchAll(INSERT_RE)];
  for (const m of stmts) {
    const at = m.index!;
    const q0 = code.lastIndexOf('"', at), q1 = code.indexOf('"', at);
    if (q0 < 0 || q1 < 0 || code.slice(q0 + 1, at).trim() !== "") {
      problems.push(`unrecognised INSERT INTO events spelling at offset ${at}: not a double-quoted SQL literal starting with INSERT. Extend the scanner or use recordEvent.`);
      continue;
    }
    const prepared = PREPARED_RE.exec(code.slice(Math.max(0, q0 - 160), q0 + 1));
    const inline = !prepared && rm !== undefined && at > rm.bodyStart && at < rm.bodyEnd;
    if (!prepared && !inline) {
      problems.push(`unrecognised INSERT INTO events spelling at offset ${at}: the scan cannot see its event type. Extend the scanner or use recordEvent.`);
      continue;
    }
    const col = eventTypeColumn(code.slice(at, q1));
    if (typeof col === "string") { problems.push(`INSERT INTO events at offset ${at}: ${col}.`); continue; }
    if (prepared) {
      const v = prepared[1], from = q1 + 1;
      const scope = code.slice(from, blockEnd(code, from));
      const runs = [...scope.matchAll(new RegExp(`\\b${v}\\.run\\(`, "g"))];
      executions[`${v}@${at}`] = runs.length;
      if (runs.length === 0) problems.push(`prepared insert ${v} at offset ${at} is never run in its block.`);
      for (const r of runs) {
        const where = `${v}.run at offset ${from + r.index!}`, ra = args(scope, r.index! + r[0].length - 1);
        if (ra.length !== col.cols) { problems.push(`${where}: ${ra.length} arguments for ${col.cols} columns.`); continue; }
        const type = ra[col.idx];
        if (/^"[^"]*"$/.test(type)) note(type.slice(1, -1), where);
        else problems.push(`${where}: event type argument ${type} is not a string literal; extend the scanner and classify it.`);
      }
    } else {
      const call = /^\s*\)\s*\.run\(/.exec(code.slice(q1 + 1));
      const ra = call ? args(code, q1 + call[0].length) : [];
      const second = /^(\w+)\s*:/.exec(rm!.params[1] ?? "")?.[1];
      if (!call || ra.length !== col.cols) problems.push(`inline insert in recordEvent at offset ${at}: expected .run(...) with ${col.cols} arguments.`);
      else if (ra[col.idx] !== "eventType" || second !== "eventType") problems.push(`inline insert in recordEvent at offset ${at}: event_type is bound to ${ra[col.idx]} and recordEvent's second parameter is ${second}; both must be eventType.`);
      else executions[`recordEvent@${at}`] = 1;
    }
  }

  // 2. recordEvent calls and any other reference.
  for (const m of code.matchAll(/\brecordEvent\b/g)) {
    const at = m.index!;
    const isThisCall = code.slice(at - 5, at) === "this." && code[at + m[0].length] === "(";
    if (rm !== undefined && code.slice(at, rm.open).trim() === "recordEvent") continue;
    if (!isThisCall) { problems.push(`recordEvent referenced at offset ${at} other than as this.recordEvent(...): the scan cannot follow it.`); continue; }
    const arg = args(code, at + m[0].length)[1];
    if (arg !== undefined && /^"[^"]*"$/.test(arg)) { note(arg.slice(1, -1), `recordEvent at offset ${at}`); continue; }
    const t = arg !== undefined ? /^`([^`$]*)\$\{(\w+)\}`$/.exec(arg) : null;
    if (!t) { problems.push(`recordEvent at offset ${at}: unrecognised event type expression ${arg}.`); continue; }
    const key = `${t[1]}\${${t[2]}}`;
    const caller = enclosing(at), ty = caller && paramType(caller, t[2]);
    if (ty === undefined) { problems.push(`recordEvent at offset ${at}: ${t[2]} is not a plain parameter of the method containing this call.`); continue; }
    if (!IS_LITERAL_UNION.test(ty)) { problems.push(`recordEvent at offset ${at}: the type of ${t[2]} is \`${ty}\`, not purely a union of string literals.`); continue; }
    const names = [...ty.matchAll(/"([^"]*)"/g)].map((x) => t[1] + x[1]);
    const expected = domains[key];
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
const SQL3 = "INSERT INTO events (id, fleet_id, event_type) VALUES (?, ?, ?)";
const FIX_BASE = `
class F {
  controlAgent(action: "pause" | "resume") {
    this.recordEvent("f", \`agent.\${action}\`, "operator", "o", "agent", "a", "", {});
  }
  deliver() {
    const eventStmt = this.db.prepare("${SQL3}");
    eventStmt.run("i", "f", "message.delivered");
  }
  recordEvent(fleetId: string, eventType: string) {
    this.db.prepare("${SQL3}").run("i", fleetId, eventType);
  }
}`;
const bad = (src: string) => analyse(src, FIX_DOMAINS).problems.length > 0;

describe("#196 R1: scanner fixtures (synthetic source)", () => {
  it("F0: baseline fixture is accepted", () => {
    expect(analyse(FIX_BASE, FIX_DOMAINS).problems).toEqual([]);
  });
  it("F1: widening a template domain is rejected", () => {
    expect(bad(FIX_BASE.replace('"pause" | "resume"', '"pause" | "resume" | "wipe"'))).toBe(true);
  });
  it("F2: a second run of one prepared insert cannot mask a missed insert elsewhere", () => {
    // stmt3 is prepared with a template literal, a spelling the scan does not read as a prepared insert.
    const masked = FIX_BASE
      .replace('eventStmt.run("i", "f", "message.delivered");', 'eventStmt.run("i", "f", "message.delivered");\n    eventStmt.run("i", "f", "message.delivered");')
      .replace("class F {", "class F {\n  other() { const stmt3 = this.db.prepare(`" + SQL3 + "`); stmt3.run(\"i\", \"f\", \"brand.new\"); }");
    expect(bad(masked)).toBe(true);
  });
  it("F3: an insert in an unscanned spelling is rejected", () => {
    expect(bad(FIX_BASE.replace("class F {", 'class F {\n  sneaky() { this.db.prepare("insert into events (id, fleet_id, event_type) values (?, ?, ?)").run("i", "f", "brand.new"); }'))).toBe(true);
  });

  // Item A: the template parameter's WHOLE type, from the calling method's own signature.
  it.each([
    ["A1: trailing non-literal member", 'action: "pause" | "resume" | string'],
    ["A2: leading non-literal member", 'action: string | "pause" | "resume"'],
    ["A3: optional parameter", 'action?: "pause" | "resume"'],
    ["A4: default value", 'action: "pause" | "resume" = "pause"'],
    ["A5: type alias", "action: ActionName"],
  ])("%s is rejected", (_n, param) => {
    expect(bad(FIX_BASE.replace('action: "pause" | "resume"', param))).toBe(true);
  });
  it("A6: a literal union of the same name in an earlier unrelated method does not count", () => {
    const s = FIX_BASE.replace("class F {", 'class F {\n  unrelated(action: "pause" | "resume") { return 1; }').replace('controlAgent(action: "pause" | "resume")', "controlAgent(action: string)");
    expect(bad(s)).toBe(true);
  });
  it("A7: a name that is not a parameter of the calling method is rejected", () => {
    expect(bad(FIX_BASE.replace('controlAgent(action: "pause" | "resume")', 'controlAgent(other: "pause" | "resume")'))).toBe(true);
  });

  // Item B: SQL column list, VALUES list and .run arguments must agree.
  it("B1: event_type moved in the column list with the argument count unchanged is rejected", () => {
    expect(bad(FIX_BASE.replaceAll("(id, fleet_id, event_type)", "(id, event_type, fleet_id)"))).toBe(true);
  });
  it.each([
    ["B2: placeholder count differs from column count", (s: string) => s.replace("VALUES (?, ?, ?)", "VALUES (?, ?)")],
    ["B3: .run argument count differs", (s: string) => s.replace('"message.delivered")', '"message.delivered", "extra")')],
    ["B4: no column list", (s: string) => s.replace("(id, fleet_id, event_type) VALUES", "VALUES")],
    ["B5: event_type listed twice", (s: string) => s.replace("(id, fleet_id, event_type)", "(id, event_type, event_type)")],
    ["B6: a value that is not a bare placeholder", (s: string) => s.replace("VALUES (?, ?, ?)", "VALUES (?, ?, 'x')")],
  ])("%s is rejected (prepared insert)", (_n, edit) => {
    expect(bad(edit(FIX_BASE))).toBe(true);
  });
  it("B7: the inline insert must bind recordEvent's second parameter", () => {
    expect(bad(FIX_BASE.replace("recordEvent(fleetId: string, eventType: string)", "recordEvent(fleetId: string, kind: string, eventType: string)"))).toBe(true);
  });
  it("B8: a .run on the same variable name in a later method is not attributed to this site", () => {
    const later = FIX_BASE.replace(/\}$/, '  later() { eventStmt.run("i", "f", "brand.new"); }\n}');
    expect(analyse(later, FIX_DOMAINS).problems).toEqual([]);
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
