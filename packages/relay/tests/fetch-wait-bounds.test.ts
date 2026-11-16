import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import { clampFetchWaitSeconds, FETCH_WAIT_MAX_SECONDS } from "../src/fetch-wait";

/** #155 follow-up: bounds for the two fetch_wait settings. No database needed. */
describe("#155: fetch_wait setting bounds", () => {
  it("clamps to [0, one day] and leaves normal values alone", () => {
    expect(clampFetchWaitSeconds(1e15)).toBe(FETCH_WAIT_MAX_SECONDS);
    expect(clampFetchWaitSeconds(Number.MAX_VALUE)).toBe(FETCH_WAIT_MAX_SECONDS);
    expect(clampFetchWaitSeconds(-5)).toBe(0);
    expect(clampFetchWaitSeconds(NaN)).toBe(0);
    expect(clampFetchWaitSeconds(120)).toBe(120); // normal values pass through unchanged
    expect(clampFetchWaitSeconds(900.5)).toBe(900.5);
  });

  it("resolves the environment settings through the same bound", async () => {
    const env = { stale: process.env.EKHO_INBOX_STALE_SECONDS, cap: process.env.EKHO_TURN_INTERVAL_CAP_SECONDS };
    try {
      process.env.EKHO_INBOX_STALE_SECONDS = "1e15";
      process.env.EKHO_TURN_INTERVAL_CAP_SECONDS = "-30";
      vi.resetModules();
      const fresh = (await import("../src/config")).config;
      expect(fresh.inboxStaleSeconds).toBe(FETCH_WAIT_MAX_SECONDS);
      expect(fresh.turnIntervalCapSeconds).toBe(0);
    } finally {
      if (env.stale === undefined) delete process.env.EKHO_INBOX_STALE_SECONDS; else process.env.EKHO_INBOX_STALE_SECONDS = env.stale;
      if (env.cap === undefined) delete process.env.EKHO_TURN_INTERVAL_CAP_SECONDS; else process.env.EKHO_TURN_INTERVAL_CAP_SECONDS = env.cap;
      vi.resetModules();
    }
  });
});
