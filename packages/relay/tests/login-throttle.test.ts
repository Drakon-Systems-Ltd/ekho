import { describe, it, expect } from "vitest";
import { LoginThrottle } from "../src/login-throttle";

const OPTS = { maxFailures: 3, windowSeconds: 60 };

/** A throttle with a hand-cranked clock so window expiry is testable. */
function makeThrottle() {
  let now = 1_000_000;
  const throttle = new LoginThrottle(OPTS, () => now);
  return { throttle, advance: (seconds: number) => { now += seconds * 1000; } };
}

describe("LoginThrottle", () => {
  it("allows attempts until the failure limit is reached", () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < OPTS.maxFailures; i++) {
      expect(throttle.check("default", "op@x", "1.2.3.4").allowed).toBe(true);
      throttle.recordFailure("default", "op@x", "1.2.3.4");
    }
    const decision = throttle.check("default", "op@x", "1.2.3.4");
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("blocks a distributed grind on one account across rotating IPs", () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < OPTS.maxFailures; i++) {
      throttle.recordFailure("default", "op@x", `10.0.0.${i}`);
    }
    // A brand-new IP still can't touch this account — the account counter trips.
    expect(throttle.check("default", "op@x", "10.0.0.99").allowed).toBe(false);
  });

  it("blocks one host spraying many different accounts", () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < OPTS.maxFailures; i++) {
      throttle.recordFailure("default", `victim${i}@x`, "9.9.9.9");
    }
    // A never-before-seen account from that same IP is refused.
    expect(throttle.check("default", "fresh@x", "9.9.9.9").allowed).toBe(false);
    // ...but the same fresh account from a clean IP is unaffected.
    expect(throttle.check("default", "fresh@x", "8.8.8.8").allowed).toBe(true);
  });

  it("forgets failures once the rolling window expires", () => {
    const { throttle, advance } = makeThrottle();
    for (let i = 0; i < OPTS.maxFailures; i++) throttle.recordFailure("default", "op@x", "1.2.3.4");
    expect(throttle.check("default", "op@x", "1.2.3.4").allowed).toBe(false);
    advance(OPTS.windowSeconds + 1);
    expect(throttle.check("default", "op@x", "1.2.3.4").allowed).toBe(true);
  });

  it("clears the account counter on a successful login", () => {
    const { throttle } = makeThrottle();
    throttle.recordFailure("default", "op@x", "1.2.3.4");
    throttle.recordFailure("default", "op@x", "1.2.3.4");
    throttle.recordSuccess("default", "op@x");
    throttle.recordFailure("default", "op@x", "5.5.5.5");
    // Only the post-success failure counts, so the operator is not locked out.
    expect(throttle.check("default", "op@x", "5.5.5.5").allowed).toBe(true);
  });

  it("does not let one valid login erase a spray from the same host", () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < OPTS.maxFailures; i++) throttle.recordFailure("default", `victim${i}@x`, "9.9.9.9");
    throttle.recordSuccess("default", "victim0@x");
    expect(throttle.check("default", "other@x", "9.9.9.9").allowed).toBe(false);
  });

  it("treats email and fleet case-insensitively so casing can't reset the count", () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < OPTS.maxFailures; i++) throttle.recordFailure("Default", "OP@X", "1.2.3.4");
    expect(throttle.check("default", "op@x", "7.7.7.7").allowed).toBe(false);
  });

  it("sweeps expired buckets so memory cannot grow without bound", () => {
    const { throttle, advance } = makeThrottle();
    for (let i = 0; i < 50; i++) throttle.recordFailure("default", `u${i}@x`, `2.2.2.${i}`);
    expect(throttle.size()).toBeGreaterThan(0);
    advance(OPTS.windowSeconds + 1);
    throttle.sweep();
    expect(throttle.size()).toBe(0);
  });
});
