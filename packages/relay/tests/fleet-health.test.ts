import { describe, it, expect } from "vitest";
import { deriveAgentHealth, deriveInboxState, buildAttentionItems, HEARTBEAT_STALE_MS, TURN_DEADLINE_GRACE_MS } from "../src/fleet-health";

const T0 = 1_700_000_000_000;
const iso = (t: number) => new Date(t).toISOString();
const fresh = iso(T0 - 20_000); // within the stale window

describe("deriveAgentHealth", () => {
  it("is ok when connected and turns are healthy", () => {
    const v = deriveAgentHealth({ status: "active", last_heartbeat_at: fresh, metrics: { turn_health: "ok" } }, T0);
    expect(v.level).toBe("ok");
    expect(v.cognitive_unknown).toBe(false);
  });

  it("stays ok but flags cognitive_unknown for an old plugin with no turn signal", () => {
    const v = deriveAgentHealth({ status: "active", last_heartbeat_at: fresh, metrics: {} }, T0);
    expect(v.level).toBe("ok");
    expect(v.cognitive_unknown).toBe(true);
    expect(v.reason).toMatch(/no turn data/);
  });

  it("treats an explicit turn_health 'unknown' (the plugin's zero-call report) exactly like absent", () => {
    const v = deriveAgentHealth(
      { status: "active", last_heartbeat_at: fresh, metrics: { turn_health: "unknown", model_calls_1h: "0" } },
      T0
    );
    expect(v).toEqual(deriveAgentHealth({ status: "active", last_heartbeat_at: fresh, metrics: {} }, T0));
    expect(v.level).toBe("ok");
    expect(v.cognitive_unknown).toBe(true);
  });

  it("is DOWN when heartbeating fine but the model fails every turn (the core fix)", () => {
    const v = deriveAgentHealth(
      { status: "active", last_heartbeat_at: fresh, metrics: { turn_health: "down", last_error: "not_found" } },
      T0
    );
    expect(v.level).toBe("down");
    expect(v.reason).toMatch(/model failing every turn/);
    expect(v.reason).toMatch(/not_found/);
  });

  it("is DOWN when the heartbeat itself is stale, regardless of last turn signal", () => {
    const v = deriveAgentHealth(
      { status: "active", last_heartbeat_at: iso(T0 - HEARTBEAT_STALE_MS - 60_000), metrics: { turn_health: "ok" } },
      T0
    );
    expect(v.level).toBe("down");
    expect(v.reason).toMatch(/no heartbeat/);
  });

  it("is DOWN with no heartbeat at all", () => {
    const v = deriveAgentHealth({ status: "active", last_heartbeat_at: null, metrics: {} }, T0);
    expect(v.level).toBe("down");
    expect(v.reason).toMatch(/no heartbeat received/);
  });

  it("reports degraded for mixed model errors", () => {
    const v = deriveAgentHealth(
      { status: "active", last_heartbeat_at: fresh, metrics: { turn_health: "degraded", model_errors_1h: "3", last_error: "overloaded" } },
      T0
    );
    expect(v.level).toBe("degraded");
    expect(v.reason).toMatch(/3\/1h/);
  });

  it("lifecycle states dominate: revoked and quarantined are down", () => {
    expect(deriveAgentHealth({ status: "revoked", last_heartbeat_at: fresh }, T0).level).toBe("down");
    expect(deriveAgentHealth({ status: "quarantined", last_heartbeat_at: fresh }, T0).reason).toBe("quarantined");
  });

  it("paused is degraded when otherwise live", () => {
    const v = deriveAgentHealth({ status: "paused", last_heartbeat_at: fresh, metrics: { turn_health: "ok" } }, T0);
    expect(v.level).toBe("degraded");
    expect(v.reason).toBe("paused");
  });
});

describe("buildAttentionItems", () => {
  const agents = [
    { id: "a_tars", display_name: "Tars", health: { level: "down", reason: "model failing every turn (not_found)", cognitive_unknown: false }, last_heartbeat_at: iso(T0 - 10_000) },
    { id: "a_case", display_name: "Case", health: { level: "degraded", reason: "model errors (3/1h)", cognitive_unknown: false }, last_heartbeat_at: iso(T0 - 20_000) },
    { id: "a_jarvis", display_name: "Jarvis", health: { level: "ok", reason: "healthy", cognitive_unknown: false }, last_heartbeat_at: iso(T0 - 5_000) }
  ];
  const agentNames = { a_tars: "Tars", a_case: "Case", a_friday: "Friday", a_edith: "Edith" };

  it("includes down + degraded agents but never healthy ones", () => {
    const items = buildAttentionItems({ agents, stalled: [], deadLetters: [], agentNames });
    expect(items.map((i) => i.kind)).toEqual(["agent_down", "agent_degraded"]);
    expect(items.find((i) => i.agentId === "a_jarvis")).toBeUndefined();
  });

  it("folds stalls and dead letters in, ranking critical first", () => {
    const items = buildAttentionItems({
      agents,
      stalled: [{ id: "e1", actor_id: "a_friday", conversation_id: "c9", created_at: iso(T0 - 1000), payload: { reason: "handoff pending, budget spent" } }],
      deadLetters: [{ id: "d1", recipient_agent_id: "a_edith", sender_agent_id: "a_tars", conversation_id: "c2", failure_reason: "max retries", dead_lettered_at: iso(T0 - 500) }],
      agentNames
    });
    // criticals (agent_down + dead_letter) come before warns (agent_degraded + stalled)
    expect(items[0].severity).toBe("critical");
    expect(items[items.length - 1].severity).toBe("warn");
    const dl = items.find((i) => i.kind === "dead_letter");
    expect(dl?.title).toMatch(/Edith/);
    expect(dl?.detail).toMatch(/Tars/);
    const stall = items.find((i) => i.kind === "stalled");
    expect(stall?.title).toMatch(/Friday/);
    expect(stall?.detail).toMatch(/handoff pending/);
  });

  it("is empty when the fleet is all-green and quiet", () => {
    expect(buildAttentionItems({ agents: [agents[2]], stalled: [], deadLetters: [], agentNames })).toEqual([]);
  });
});

describe("deriveInboxState (#155 Phase 2)", () => {
  const STALE = 120;
  const old = iso(T0 - 121_000); // just past the threshold
  const recentPoll = iso(T0 - 5_000);
  const base = { queued: 0, stale_seconds: STALE } as const;

  it("is idle with nothing queued", () => {
    expect(deriveInboxState({ ...base, last_poll_at: recentPoll }, T0)).toBe("idle");
  });

  it("is idle with nothing queued even if never polled", () => {
    expect(deriveInboxState({ ...base, last_poll_at: null }, T0)).toBe("idle");
  });

  it("is queued when work is queued within the threshold", () => {
    expect(deriveInboxState({ ...base, queued: 2, oldest_queued_at: iso(T0 - 30_000), last_poll_at: null }, T0)).toBe("queued");
  });

  it("is unresponsive_inbox when the oldest queued is past the threshold and the last poll is null", () => {
    expect(deriveInboxState({ ...base, queued: 1, oldest_queued_at: old, last_poll_at: null }, T0)).toBe("unresponsive_inbox");
  });

  it("is unresponsive_inbox when the last poll is also older than the threshold", () => {
    expect(deriveInboxState({ ...base, queued: 1, oldest_queued_at: old, last_poll_at: old }, T0)).toBe("unresponsive_inbox");
  });

  it("stays queued when the agent polled recently, even with old queued work", () => {
    expect(deriveInboxState({ ...base, queued: 1, oldest_queued_at: old, last_poll_at: recentPoll }, T0)).toBe("queued");
  });

  it("uses a strict boundary: exactly at the threshold is not yet unresponsive", () => {
    const edge = iso(T0 - STALE * 1000);
    expect(deriveInboxState({ ...base, queued: 1, oldest_queued_at: edge, last_poll_at: null }, T0)).toBe("queued");
    const pollEdge = iso(T0 - STALE * 1000);
    expect(deriveInboxState({ ...base, queued: 1, oldest_queued_at: old, last_poll_at: pollEdge }, T0)).toBe("queued");
    expect(deriveInboxState({ ...base, queued: 1, oldest_queued_at: iso(T0 - STALE * 1000 - 1), last_poll_at: null }, T0)).toBe("unresponsive_inbox");
  });

  it("is working when a turn is reported running, with queued work behind it", () => {
    const metrics = { adapter_state: "turn_running", turn_started_at: iso(T0 - 200_000), turn_deadline_at: iso(T0 + 600_000) };
    expect(deriveInboxState({ ...base, queued: 3, oldest_queued_at: old, last_poll_at: old, metrics }, T0)).toBe("working");
    expect(deriveInboxState({ ...base, queued: 0, metrics }, T0)).toBe("working");
  });

  it("is unresponsive_inbox when a reported turn is past turn_deadline_at + 60 s (wedged)", () => {
    const deadline = T0 - TURN_DEADLINE_GRACE_MS - 1;
    const metrics = { adapter_state: "turn_running", turn_deadline_at: iso(deadline) };
    expect(deriveInboxState({ ...base, queued: 1, oldest_queued_at: old, last_poll_at: recentPoll, metrics }, T0)).toBe("unresponsive_inbox");
    // At the grace boundary it is still working.
    const atEdge = { adapter_state: "turn_running", turn_deadline_at: iso(T0 - TURN_DEADLINE_GRACE_MS) };
    expect(deriveInboxState({ ...base, queued: 1, oldest_queued_at: old, last_poll_at: recentPoll, metrics: atEdge }, T0)).toBe("working");
  });

  it("a wedged turn with nothing queued is working, not unresponsive", () => {
    const metrics = { adapter_state: "turn_running", turn_deadline_at: iso(T0 - 3_600_000) };
    expect(deriveInboxState({ ...base, queued: 0, metrics }, T0)).toBe("working");
  });

  it("is floor_wait when deliveries wait on a floor and no turn is running", () => {
    expect(deriveInboxState({ ...base, queued: 0, floor_waits: 1 }, T0)).toBe("floor_wait");
  });

  it("applies rules in order: unresponsive beats working beats floor_wait beats queued", () => {
    const running = { adapter_state: "turn_running" };
    expect(deriveInboxState({ ...base, queued: 1, oldest_queued_at: iso(T0 - 1000), floor_waits: 1, metrics: running }, T0)).toBe("working");
    expect(deriveInboxState({ ...base, queued: 1, oldest_queued_at: iso(T0 - 1000), floor_waits: 1, last_poll_at: recentPoll }, T0)).toBe("floor_wait");
    expect(deriveInboxState({ ...base, queued: 1, oldest_queued_at: old, floor_waits: 1, last_poll_at: null }, T0)).toBe("unresponsive_inbox");
  });

  it("never throws on malformed heartbeat fields and treats them as absent", () => {
    const metrics = { adapter_state: 5, turn_started_at: {}, turn_deadline_at: ["x"] } as unknown as Record<string, unknown>;
    expect(deriveInboxState({ ...base, queued: 1, oldest_queued_at: old, last_poll_at: null, metrics }, T0)).toBe("unresponsive_inbox");
    expect(deriveInboxState({ ...base, queued: 0, metrics }, T0)).toBe("idle");
    const bad = { adapter_state: "turn_running", turn_deadline_at: "not-a-date" };
    expect(deriveInboxState({ ...base, queued: 1, oldest_queued_at: old, last_poll_at: recentPoll, metrics: bad }, T0)).toBe("working");
    expect(deriveInboxState({ ...base, queued: 1, oldest_queued_at: "garbage", last_poll_at: null }, T0)).toBe("queued");
  });

  it("has no heartbeat input: an inbox that never polls is unresponsive however fresh its heartbeat", () => {
    const metrics = { turn_health: "ok" };
    expect(deriveInboxState({ ...base, queued: 1, oldest_queued_at: old, last_poll_at: null, metrics }, T0)).toBe("unresponsive_inbox");
  });
});
