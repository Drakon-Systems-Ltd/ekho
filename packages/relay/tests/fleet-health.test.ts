import { describe, it, expect } from "vitest";
import { deriveAgentHealth, HEARTBEAT_STALE_MS } from "../src/fleet-health";

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
