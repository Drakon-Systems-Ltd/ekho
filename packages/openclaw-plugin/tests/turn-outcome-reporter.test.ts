import { describe, it, expect, vi } from "vitest";
import { createTurnOutcomeReporter } from "../src/autoreply";

// turn-health.test.ts covers the arithmetic. This covers the WIRING — the part
// that actually broke: a spawned reply turn's outcome reaching the parent
// gateway exactly once, however the child ends.
describe("createTurnOutcomeReporter", () => {
  it("reports the first outcome through to turn-health", () => {
    const report = vi.fn();
    createTurnOutcomeReporter(report)("completed");
    expect(report).toHaveBeenCalledExactlyOnceWith("completed", undefined);
  });

  it("passes the error category through", () => {
    const report = vi.fn();
    createTurnOutcomeReporter(report)("error", "exit_1");
    expect(report).toHaveBeenCalledWith("error", "exit_1");
  });

  it("counts a timed-out turn once, not twice", () => {
    // The real double-fire: the timeout SIGTERMs the child, then the child
    // emits 'exit'. Both call the reporter. Counting both would make one failed
    // turn look like two and skew the health ratio.
    const report = vi.fn();
    const note = createTurnOutcomeReporter(report);
    note("error", "timeout");
    note("error", "exit_signal");
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith("error", "timeout");
  });

  it("keeps the first outcome even when the later one disagrees", () => {
    const report = vi.fn();
    const note = createTurnOutcomeReporter(report);
    note("error", "timeout");
    note("completed");
    expect(report).toHaveBeenCalledExactlyOnceWith("error", "timeout");
  });

  it("gives each turn its own independent guard", () => {
    const report = vi.fn();
    createTurnOutcomeReporter(report)("completed");
    createTurnOutcomeReporter(report)("error", "spawn_error");
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("never lets a telemetry failure escape into the turn", () => {
    const boom = vi.fn(() => { throw new Error("turn-health unavailable"); });
    const note = createTurnOutcomeReporter(boom);
    expect(() => note("completed")).not.toThrow();
    // Still marked as noted, so a broken telemetry sink can't cause a retry storm.
    note("error", "exit_1");
    expect(boom).toHaveBeenCalledTimes(1);
  });
});
