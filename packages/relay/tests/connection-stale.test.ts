import { describe, it, expect } from "vitest";
import { isConnectionStale } from "../frontend/src/connection.js";

const POLL = 5000;

describe("isConnectionStale", () => {
  it("is fresh right after a successful poll", () => {
    expect(isConnectionStale(1_000_000, 1_000_000 + POLL, POLL)).toBe(false);
  });

  it("is not stale at exactly the threshold (2.5x poll)", () => {
    expect(isConnectionStale(0, POLL * 2.5, POLL)).toBe(false);
  });

  it("goes stale once failures exceed ~2.5 poll intervals", () => {
    expect(isConnectionStale(0, POLL * 2.5 + 1, POLL)).toBe(true);
    expect(isConnectionStale(0, POLL * 10, POLL)).toBe(true);
  });

  it("honours a custom factor", () => {
    expect(isConnectionStale(0, POLL * 4, POLL, 5)).toBe(false);
    expect(isConnectionStale(0, POLL * 6, POLL, 5)).toBe(true);
  });
});
