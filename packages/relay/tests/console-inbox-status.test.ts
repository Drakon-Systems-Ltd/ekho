import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Pure console helper for the Health tab inbox badge (#155 Phase 4-H). No React/DOM.
import { inboxStatus } from "../frontend/src/inboxStatus.js";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const BANNED = /\b(answered|completed|stuck|read)\b/i;

function agent(inbox: Record<string, unknown> | undefined, metrics: Record<string, unknown> = {}) {
  return { id: "a1", metrics, ...(inbox === undefined ? {} : { inbox }) };
}
const base = { queued: 0, oldest_queued_at: null, delivered_unacked: 0, last_poll_at: ago(30) };

describe("console inboxStatus: one row per relay state", () => {
  it("working: neutral, with run time and queued-behind count when valid", () => {
    const r = inboxStatus(agent({ ...base, state: "working", queued: 2, oldest_queued_at: ago(120) },
      { adapter_state: "turn_running", turn_started_at: ago(240) }), NOW)!;
    expect(r.label).toBe("working");
    expect(r.tone).toBe("neutral");
    expect(r.detail).toContain("4m");
    expect(r.detail).toContain("2 queued behind");
  });

  it("working with no usable start time says no duration, and no queue says no queued count", () => {
    for (const started of [undefined, "garbage", new Date(NOW + 600_000).toISOString()]) {
      const r = inboxStatus(agent({ ...base, state: "working" },
        { adapter_state: "turn_running", ...(started ? { turn_started_at: started } : {}) }), NOW)!;
      expect(r.label).toBe("working");
      expect(r.detail).not.toMatch(/\d+\s*[smh]\b/);
      expect(r.detail).not.toContain("queued behind");
    }
  });

  it("unresponsive_inbox + turn_running: 'turn past deadline', danger", () => {
    const r = inboxStatus(agent({ ...base, state: "unresponsive_inbox", queued: 3, oldest_queued_at: ago(1800) },
      { adapter_state: "turn_running" }), NOW)!;
    expect(r.label).toBe("turn past deadline");
    expect(r.tone).toBe("danger");
    expect(r.detail).toContain("3 queued");
    expect(r.detail).toContain("30m");
  });

  it("unresponsive_inbox + another reported adapter state: 'inbox not fetching', danger", () => {
    const r = inboxStatus(agent({ ...base, state: "unresponsive_inbox", queued: 1, oldest_queued_at: ago(900), last_poll_at: ago(3600) },
      { adapter_state: "idle" }), NOW)!;
    expect(r.label).toBe("inbox not fetching");
    expect(r.tone).toBe("danger");
    expect(r.detail).toContain("1 queued");
    expect(r.detail).toContain("15m");
    expect(r.detail).toContain("last poll 1h");
  });

  it("an OpenClaw-shaped idle report with a stale poll and old queued work is danger", () => {
    const r = inboxStatus(agent({ ...base, state: "unresponsive_inbox", queued: 5, oldest_queued_at: ago(7200), last_poll_at: ago(7200) },
      { adapter_state: "idle" }), NOW)!;
    expect(r.tone).toBe("danger");
  });

  it("Hermes-shaped row (no adapter_state) in unresponsive_inbox is warn, carries the note, never danger", () => {
    for (const metrics of [{}, { model: "x" }, { adapter_state: "" }, { adapter_state: 7 }, { adapter_state: null }]) {
      const r = inboxStatus(agent({ ...base, state: "unresponsive_inbox", queued: 4, oldest_queued_at: ago(1200), last_poll_at: ago(900) },
        metrics as Record<string, unknown>), NOW)!;
      expect(r.label).toBe("not fetching");
      expect(r.tone).toBe("warn");
      expect(r.tone).not.toBe("danger");
      expect(r.title).toContain("does not report turns");
      expect(r.detail).toContain("does not report turns"); // visible on touch, where titles are not
      expect(r.detail).toContain("4 queued");
    }
  });

  it("floor_wait: neutral, no holder and no duration invented", () => {
    const r = inboxStatus(agent({ ...base, state: "floor_wait", queued: 1, oldest_queued_at: ago(90) }), NOW)!;
    expect(r.label).toBe("waiting on floor");
    expect(r.tone).toBe("neutral");
    expect(r.detail).toBe("");
  });

  it("queued: 'N queued', neutral, oldest age and last poll", () => {
    const r = inboxStatus(agent({ ...base, state: "queued", queued: 2, oldest_queued_at: ago(60), last_poll_at: ago(20) }), NOW)!;
    expect(r.label).toBe("2 queued");
    expect(r.tone).toBe("neutral");
    expect(r.detail).toContain("oldest 1m");
    expect(r.detail).toContain("last poll 20s");
  });

  it("idle: muted, with last poll or 'never polled'", () => {
    const polled = inboxStatus(agent({ ...base, state: "idle", last_poll_at: ago(300) }), NOW)!;
    expect(polled.label).toBe("inbox idle");
    expect(polled.tone).toBe("muted");
    expect(polled.detail).toContain("last poll 5m");
    const never = inboxStatus(agent({ ...base, state: "idle", last_poll_at: null }), NOW)!;
    expect(never.detail).toContain("never polled");
  });

  it("shows delivered_unacked only when above zero", () => {
    const none = inboxStatus(agent({ ...base, state: "idle", delivered_unacked: 0 }), NOW)!;
    expect(none.detail).not.toContain("not acknowledged");
    const some = inboxStatus(agent({ ...base, state: "idle", delivered_unacked: 3 }), NOW)!;
    expect(some.detail).toContain("3 fetched, not acknowledged");
  });
});

describe("console inboxStatus: bad input draws nothing or 'unknown', never a number", () => {
  it("no inbox or an unknown state draws nothing", () => {
    expect(inboxStatus(agent(undefined), NOW)).toBeNull();
    expect(inboxStatus(agent({ ...base, state: "mystery" }), NOW)).toBeNull();
    expect(inboxStatus(agent({ ...base }), NOW)).toBeNull();
    expect(inboxStatus(null as never, NOW)).toBeNull();
    expect(inboxStatus({} as never, NOW)).toBeNull();
    expect(inboxStatus({ inbox: "idle" } as never, NOW)).toBeNull();
  });

  it("negative, non-numeric or missing counts and bad times never throw or invent a number", () => {
    const r = inboxStatus(agent({ state: "queued", queued: -4, oldest_queued_at: "nope", delivered_unacked: -2, last_poll_at: "also nope" }), NOW)!;
    expect(r).not.toBeNull();
    expect(r.label).not.toMatch(/-?\d/);
    expect(r.detail).not.toMatch(/-\d/);
    expect(r.detail).not.toContain("not acknowledged");
    const r2 = inboxStatus(agent({ state: "unresponsive_inbox", queued: "x", oldest_queued_at: undefined }, { adapter_state: "idle" }), NOW)!;
    expect(r2.tone).toBe("danger");
    expect(r2.detail).not.toMatch(/NaN|undefined|null/);
  });

  it("a future oldest_queued_at or last_poll_at gives no age", () => {
    const fut = new Date(NOW + 3_600_000).toISOString();
    const r = inboxStatus(agent({ ...base, state: "queued", queued: 1, oldest_queued_at: fut, last_poll_at: fut }), NOW)!;
    expect(r.detail).not.toMatch(/oldest \d/);
    expect(r.detail).not.toMatch(/last poll \d/);
  });

  it("does not re-derive the state from raw numbers", () => {
    // Relay says idle even though raw numbers look alarming: the console draws idle.
    const r = inboxStatus(agent({ state: "idle", queued: 9, oldest_queued_at: ago(99999), last_poll_at: null }), NOW)!;
    expect(r.label).toBe("inbox idle");
    expect(r.tone).toBe("muted");
  });
});

describe("console inboxStatus: wording", () => {
  it("no label, detail or title contains a banned word", () => {
    const states = ["working", "unresponsive_inbox", "floor_wait", "queued", "idle"];
    const metricSets = [{}, { adapter_state: "turn_running", turn_started_at: ago(60) }, { adapter_state: "idle" }];
    for (const state of states) for (const metrics of metricSets) for (const du of [0, 2]) {
      const r = inboxStatus(agent({ state, queued: 2, oldest_queued_at: ago(600), delivered_unacked: du, last_poll_at: ago(700) }, metrics), NOW);
      if (!r) continue;
      for (const s of [r.label, r.detail, r.title]) expect(s).not.toMatch(BANNED);
    }
  });
});

describe("console wiring", () => {
  // Weak source-text pin: CI does not build the frontend, so this only proves
  // HealthTab imports and calls the helper, not that it renders.
  it("HealthTab calls inboxStatus", () => {
    const src = readFileSync(fileURLToPath(new URL("../frontend/src/App.jsx", import.meta.url)), "utf8");
    expect(src).toMatch(/import \{ inboxStatus \} from "\.\/inboxStatus\.js"/);
    const tab = src.slice(src.indexOf("function HealthTab"));
    expect(tab.slice(0, tab.indexOf("\n}\n"))).toMatch(/inboxStatus\(a, /);
  });
});
