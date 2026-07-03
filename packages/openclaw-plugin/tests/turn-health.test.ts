import { describe, it, expect, beforeEach } from "vitest";
import {
  deriveTurnHealth,
  noteModelCallEnded,
  turnHealthMetrics,
  __resetTurnHealth,
  type ModelCallOutcome
} from "../src/connection";

const T0 = 1_700_000_000_000; // fixed epoch so thresholds are deterministic
const ok = (t: number): ModelCallOutcome => ({ t, ok: true });
const err = (t: number, category = "not_found"): ModelCallOutcome => ({ t, ok: false, category });

describe("deriveTurnHealth", () => {
  it("returns unknown with no calls in the window (never invents health)", () => {
    expect(deriveTurnHealth([], T0).turn_health).toBe("unknown");
    // a call older than the 1h window is pruned out -> still unknown
    expect(deriveTurnHealth([ok(T0 - 2 * 3600_000)], T0).turn_health).toBe("unknown");
  });

  it("is ok when recent calls all completed", () => {
    const h = deriveTurnHealth([ok(T0 - 10_000), ok(T0 - 5_000), ok(T0 - 1_000)], T0);
    expect(h.turn_health).toBe("ok");
    expect(h.errors_1h).toBe(0);
    expect(h.last_error).toBeUndefined();
    expect(h.last_ok_at).toBe(T0 - 1_000);
  });

  it("is DOWN when nothing completes — the Tars 404 case", () => {
    const h = deriveTurnHealth([err(T0 - 9_000, "not_found"), err(T0 - 3_000, "not_found")], T0);
    expect(h.turn_health).toBe("down");
    expect(h.last_error).toBe("not_found");
    expect(h.calls_1h).toBe(2);
    expect(h.errors_1h).toBe(2);
  });

  it("is degraded when errors are mixed with successes", () => {
    const h = deriveTurnHealth([ok(T0 - 20_000), err(T0 - 10_000), ok(T0 - 5_000)], T0);
    expect(h.turn_health).toBe("degraded");
    expect(h.errors_1h).toBe(1);
  });

  it("flips a previously-healthy agent to down after a run of 3+ failures", () => {
    const h = deriveTurnHealth(
      [ok(T0 - 60_000), err(T0 - 30_000), err(T0 - 20_000), err(T0 - 10_000)],
      T0
    );
    expect(h.turn_health).toBe("down");
  });

  it("recovers to degraded once a success lands after the failing run", () => {
    const h = deriveTurnHealth(
      [err(T0 - 30_000), err(T0 - 20_000), err(T0 - 10_000), ok(T0 - 1_000)],
      T0
    );
    expect(h.turn_health).toBe("degraded"); // has success + errors in window, tail not failing
  });
});

describe("noteModelCallEnded + turnHealthMetrics (module state)", () => {
  beforeEach(() => __resetTurnHealth());

  it("emits no turn keys before any call (old behaviour preserved)", () => {
    expect(turnHealthMetrics(T0)).toEqual({});
  });

  it("reports a down verdict with the error category after failing calls", () => {
    noteModelCallEnded("error", "unauthorized", T0 - 5_000);
    noteModelCallEnded("error", "unauthorized", T0 - 1_000);
    const m = turnHealthMetrics(T0);
    expect(m.turn_health).toBe("down");
    expect(m.last_error).toBe("unauthorized");
    expect(m.model_errors_1h).toBe("2");
    expect(m.model_calls_1h).toBe("2");
  });

  it("reports ok and omits last_error after a successful call", () => {
    noteModelCallEnded("completed", undefined, T0 - 1_000);
    const m = turnHealthMetrics(T0);
    expect(m.turn_health).toBe("ok");
    expect(m.last_error).toBeUndefined();
    expect(m.last_ok_at).toBe(new Date(T0 - 1_000).toISOString());
  });
});
