import { describe, it, expect } from "vitest";
import { classifyFetchWait, FETCH_WAIT_BUSY_COVERAGE } from "../src/fetch-wait";

/**
 * #155 — the pure `fetch_wait` rule (design §2.3), without a relay.
 * Times are plain epoch milliseconds so the arithmetic is exact.
 */
describe("#155: classifyFetchWait", () => {
  const T0 = Date.parse("2026-11-01T12:00:00.000Z");
  const s = (n: number) => T0 + n * 1000;
  const isoAt = (n: number) => new Date(s(n)).toISOString();
  const base = { staleMs: 120_000, capMs: 900_000, deliveryAttempts: 1 };
  const gap = (from: number, to: number) => ({ queuedAt: isoAt(from), deliveredAt: isoAt(to) });

  it("is null without a fetch, with unparseable times, or after a refetch", () => {
    expect(classifyFetchWait({ ...base, queuedAt: isoAt(0), deliveredAt: null, intervals: [] })).toBeNull();
    expect(classifyFetchWait({ ...base, queuedAt: null, deliveredAt: isoAt(5), intervals: [] })).toBeNull();
    expect(classifyFetchWait({ ...base, queuedAt: "not a time", deliveredAt: isoAt(5), intervals: [] })).toBeNull();
    expect(classifyFetchWait({ ...base, ...gap(0, 600), deliveryAttempts: 2, intervals: [] })).toBeNull();
  });

  it("is prompt up to and including the threshold, whatever the intervals say", () => {
    expect(classifyFetchWait({ ...base, ...gap(0, 1), intervals: [] })).toBe("prompt");
    expect(classifyFetchWait({ ...base, ...gap(0, 120), intervals: [] })).toBe("prompt");
    // A fetch recorded before the queue time (clock step) is not a long wait.
    expect(classifyFetchWait({ ...base, ...gap(10, 0), intervals: [] })).toBe("prompt");
  });

  it("splits a long gap at 80 % union coverage", () => {
    expect(FETCH_WAIT_BUSY_COVERAGE).toBe(0.8);
    const g = gap(0, 1000);
    const iv = (a: number, b: number | null) => ({ startedAt: isoAt(a), endedAt: b === null ? null : isoAt(b) });
    expect(classifyFetchWait({ ...base, ...g, intervals: [] })).toBe("inbox_stalled");
    expect(classifyFetchWait({ ...base, ...g, intervals: [iv(0, 799)] })).toBe("inbox_stalled");
    expect(classifyFetchWait({ ...base, ...g, intervals: [iv(0, 800)] })).toBe("adapter_busy");
    // Overlap and duplicates count once; touching pieces add up.
    expect(classifyFetchWait({ ...base, ...g, intervals: [iv(0, 500), iv(0, 500), iv(250, 500)] })).toBe("inbox_stalled");
    expect(classifyFetchWait({ ...base, ...g, intervals: [iv(600, 900), iv(0, 500)] })).toBe("adapter_busy");
    // Only the part inside the gap counts.
    expect(classifyFetchWait({ ...base, ...g, intervals: [iv(-500, 300), iv(900, 1800)] })).toBe("inbox_stalled");
  });

  it("caps open and over-long intervals at capMs and ignores malformed ones", () => {
    const iv = (a: number, b: number | null) => ({ startedAt: isoAt(a), endedAt: b === null ? null : isoAt(b) });
    // Open: runs to start + cap (900 s).
    expect(classifyFetchWait({ ...base, ...gap(0, 1000), intervals: [iv(0, null)] })).toBe("adapter_busy");
    expect(classifyFetchWait({ ...base, ...gap(0, 1200), intervals: [iv(0, null)] })).toBe("inbox_stalled");
    // Reported far longer than any turn can run: counted for cap only.
    expect(classifyFetchWait({ ...base, ...gap(0, 1200), intervals: [iv(0, 50_000)] })).toBe("inbox_stalled");
    // An end before the start, or an unparseable start, contributes nothing.
    expect(classifyFetchWait({ ...base, ...gap(0, 1000), intervals: [iv(900, 0)] })).toBe("inbox_stalled");
    expect(classifyFetchWait({ ...base, ...gap(0, 1000), intervals: [{ startedAt: "nope", endedAt: null }] })).toBe("inbox_stalled");
    // An unparseable end is treated as open.
    expect(classifyFetchWait({ ...base, ...gap(0, 1000), intervals: [{ startedAt: isoAt(0), endedAt: "nope" }] })).toBe("adapter_busy");
  });
});
