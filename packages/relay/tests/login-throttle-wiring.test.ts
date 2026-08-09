import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestRelay } from "./setup";
import { DEFAULT_LOGIN_THROTTLE } from "../src/login-throttle";

// Behind `tailscale serve` every external client reaches the relay from the
// proxy's loopback socket, so keying the throttle on the raw socket address
// collapses all operators into ONE shared bucket: 10 bad guesses from anyone
// locked out every operator fleet-wide for the window (issue #8). These tests
// pin the fix — the forwarded client IP from the single trusted hop is the
// throttle key, while a direct (untrusted-socket) client cannot spoof
// X-Forwarded-For to dodge its own bucket.
describe("login throttle is proxy-aware (#8)", () => {
  let relay: Awaited<ReturnType<typeof createTestRelay>>;

  beforeAll(async () => {
    relay = await createTestRelay();
  });

  afterAll(() => { relay.cleanup(); });

  async function login(opts: { password: string; email?: string; xff?: string; remoteAddress?: string }) {
    return relay.app.inject({
      method: "POST",
      url: "/v1/operator/login",
      remoteAddress: opts.remoteAddress ?? "127.0.0.1",
      headers: {
        "content-type": "application/json",
        ...(opts.xff ? { "x-forwarded-for": opts.xff } : {})
      },
      payload: {
        fleet_name: relay.fleetName,
        email: opts.email ?? "attacker-probe@test.com",
        password: opts.password
      }
    });
  }

  it("an attacker tripping the throttle via the proxy does not lock out other clients", async () => {
    // Attacker (forwarded IP A) burns through the limit via the trusted loopback hop.
    for (let i = 0; i < DEFAULT_LOGIN_THROTTLE.maxFailures + 2; i++) {
      await login({ password: "wrong-password", xff: "203.0.113.5" });
    }
    const attackerBlocked = await login({ password: "wrong-password", xff: "203.0.113.5" });
    expect(attackerBlocked.statusCode).toBe(429);

    // A legitimate operator (forwarded IP B) through the SAME proxy socket must
    // still be able to log in — on the pre-fix code this was 429.
    const legit = await login({ password: "testpassword1", email: relay.operatorEmail, xff: "203.0.113.9" });
    expect(legit.statusCode).toBe(200);
  });

  it("a direct client cannot evade its bucket by rotating X-Forwarded-For", async () => {
    // Socket address is NOT a trusted proxy → the spoofed header must be ignored.
    let blocked = false;
    for (let i = 0; i < DEFAULT_LOGIN_THROTTLE.maxFailures + 2; i++) {
      const res = await login({
        password: "wrong-password",
        // Rotate the email so only the IP bucket can trip — this isolates the
        // header-spoof question from the account counter.
        email: `direct-${i}@test.com`,
        remoteAddress: "198.51.100.7",
        xff: `10.0.0.${i}` // rotating spoof — would reset the bucket if trusted
      });
      if (res.statusCode === 429) { blocked = true; break; }
    }
    expect(blocked).toBe(true);
  });

  it("only the rightmost forwarded entry (appended by our hop) is believed", async () => {
    // The left-hand entries are attacker-supplied; rotating them must not evade
    // the bucket keyed on the rightmost (proxy-appended) address.
    let blocked = false;
    for (let i = 0; i < DEFAULT_LOGIN_THROTTLE.maxFailures + 2; i++) {
      const res = await login({
        password: "wrong-password",
        email: `rightmost-${i}@test.com`, // isolate the IP bucket, as above
        xff: `10.9.9.${i}, 192.0.2.77`
      });
      if (res.statusCode === 429) { blocked = true; break; }
    }
    expect(blocked).toBe(true);
  });
});

// The throttle's logic is covered in login-throttle.test.ts. This proves it is
// actually enforced on the live /v1/operator/login route — the endpoint that
// was previously open to unlimited password guessing.
describe("operator login is brute-force throttled", () => {
  let relay: Awaited<ReturnType<typeof createTestRelay>>;
  let fleetName: string;

  beforeAll(async () => {
    relay = await createTestRelay();
    fleetName = relay.fleetName;
  });

  afterAll(() => { relay.cleanup(); });

  async function login(password: string, email = `attacker-probe@test.com`) {
    return relay.app.inject({
      method: "POST",
      url: "/v1/operator/login",
      headers: { "content-type": "application/json" },
      payload: { fleet_name: fleetName, email, password }
    });
  }

  it("returns 429 with Retry-After once the failure limit is exceeded", async () => {
    let sawTooMany = false;
    let retryAfter: string | undefined;

    // One more attempt than the limit allows.
    for (let i = 0; i < DEFAULT_LOGIN_THROTTLE.maxFailures + 1; i++) {
      const res = await login("definitely-wrong-password");
      if (res.statusCode === 429) {
        sawTooMany = true;
        retryAfter = String(res.headers["retry-after"]);
        break;
      }
      // Until the limit trips, a wrong password is a plain 401.
      expect(res.statusCode).toBe(401);
    }

    expect(sawTooMany).toBe(true);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("blocks the guessing even when the password would be correct", async () => {
    // The counter is already tripped by the previous test (same IP), so even a
    // valid credential is refused — the throttle runs before authentication.
    const res = await login("testpassword1", relay.operatorEmail);
    expect(res.statusCode).toBe(429);
  });
});
