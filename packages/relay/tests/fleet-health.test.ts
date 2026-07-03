import { describe, it, expect } from "vitest";
import { deriveAgentHealth, buildAttentionItems, HEARTBEAT_STALE_MS } from "../src/fleet-health";

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
