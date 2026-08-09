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

// resolveClientIp is the #8 fix: unwrap exactly one trusted forwarding hop,
// believe nothing an untrusted peer says about itself.
import { resolveClientIp } from "../src/login-throttle";
import { describe as describe2, it as it2, expect as expect2 } from "vitest";

describe2("resolveClientIp", () => {
  const trusted = ["127.0.0.1", "::1"];

  it2("returns the socket IP for a direct connection, ignoring any spoofed header", () => {
    expect2(resolveClientIp("198.51.100.7", "10.0.0.1", trusted)).toBe("198.51.100.7");
    expect2(resolveClientIp("198.51.100.7", undefined, trusted)).toBe("198.51.100.7");
  });

  it2("unwraps the forwarded IP when the socket is a trusted proxy", () => {
    expect2(resolveClientIp("127.0.0.1", "203.0.113.5", trusted)).toBe("203.0.113.5");
  });

  it2("takes only the rightmost entry of a forwarded chain", () => {
    expect2(resolveClientIp("127.0.0.1", "10.1.1.1, 10.2.2.2, 203.0.113.9", trusted)).toBe("203.0.113.9");
  });

  it2("takes the last header when the header is repeated (array)", () => {
    expect2(resolveClientIp("127.0.0.1", ["10.1.1.1", "203.0.113.7"], trusted)).toBe("203.0.113.7");
  });

  it2("falls back to the socket IP when the trusted hop sends no/empty header", () => {
    expect2(resolveClientIp("127.0.0.1", undefined, trusted)).toBe("127.0.0.1");
    expect2(resolveClientIp("127.0.0.1", "", trusted)).toBe("127.0.0.1");
    expect2(resolveClientIp("127.0.0.1", "  ,  ", trusted)).toBe("127.0.0.1");
  });

  it2("no trusted proxies configured means the socket is always the answer", () => {
    expect2(resolveClientIp("127.0.0.1", "203.0.113.5", [])).toBe("127.0.0.1");
  });
});
