import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PRUNABLE_EVENT_TYPES } from "../src/db";

// #196 R1: every event type the relay writes must be classified as pruned
// (PRUNABLE_EVENT_TYPES) or retained forever (RETAINED_FOREVER, below). Static
// text scan of db.ts only: no database is opened and no rows are touched.

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

const src = fs.readFileSync(path.join(__dirname, "..", "src", "db.ts"), "utf8");

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
const code = stripComments(src);

/** Top-level comma-separated arguments of the call whose "(" is at `open`. */
function args(open: number): string[] {
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

type Site = { arg: string; where: string };
function scan(): Site[] {
  const sites: Site[] = [];
  for (const m of code.matchAll(/this\.recordEvent\(/g)) {
    sites.push({ arg: args(m.index! + m[0].length - 1)[1], where: `recordEvent call at offset ${m.index}` });
  }
  // Direct inserts: find the statement variable, then its .run(...) calls.
  for (const m of code.matchAll(/const (\w+) = this\.db\.prepare\(\s*"INSERT INTO events/g)) {
    for (const r of code.matchAll(new RegExp(`\\b${m[1]}\\.run\\(`, "g"))) {
      const type = args(r.index! + r[0].length - 1)[2];
      if (type !== "eventType") sites.push({ arg: type, where: `${m[1]}.run at offset ${r.index}` });
    }
  }
  return sites;
}
const sites = scan();
const literals = new Set<string>();
const templates: string[] = [];
for (const s of sites) {
  if (/^"[^"]*"$/.test(s.arg)) literals.add(s.arg.slice(1, -1));
  else if (/^`[^`$]*\$\{[^}]+\}`$/.test(s.arg)) templates.push(s.arg.slice(1, s.arg.indexOf("${")));
  else throw new Error(`Unrecognised event type expression ${s.arg} (${s.where}): extend the scanner and classify it.`);
}

describe("#196 R1: event type retention classification", () => {
  it("T1: every literal event type is pruned or retained forever", () => {
    const unclassified = [...literals].filter((t) => !PRUNABLE_EVENT_TYPES.has(t) && !RETAINED_FOREVER.has(t));
    expect(unclassified, `Event type(s) ${unclassified.join(", ")} are in neither PRUNABLE_EVENT_TYPES nor RETAINED_FOREVER. Classify them deliberately (#196).`).toEqual([]);
  });

  it("T2: template types are matched by prefix and retained", () => {
    expect(templates.sort()).toEqual(["agent.", "approval."]);
    for (const p of templates) expect(RETAINED_TEMPLATE_PREFIXES).toContain(p);
  });

  it("T3: lists are disjoint and every pruned type is actually written", () => {
    const both = [...RETAINED_FOREVER].filter((t) => PRUNABLE_EVENT_TYPES.has(t));
    expect(both).toEqual([]);
    const unwritten = [...PRUNABLE_EVENT_TYPES].filter((t) => !literals.has(t));
    expect(unwritten).toEqual([]);
    const stale = [...RETAINED_FOREVER].filter((t) => !literals.has(t));
    expect(stale, "RETAINED_FOREVER lists a type nothing writes").toEqual([]);
  });

  it("T4: message.delivered is recorded as retained forever (today's behaviour, see #196)", () => {
    expect(RETAINED_FOREVER.has("message.delivered")).toBe(true);
    expect(PRUNABLE_EVENT_TYPES.has("message.delivered")).toBe(false);
  });

  it("T5: scanner finds every event write site", () => {
    const calls = (code.match(/recordEvent\(/g) ?? []).length - 1; // minus the definition
    const inserts = (code.match(/INSERT INTO events/g) ?? []).length - 1; // minus the one inside recordEvent
    expect(sites.length).toBe(calls + inserts);
  });
});
