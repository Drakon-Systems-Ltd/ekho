import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestRelay } from "./setup";
import { DEFAULT_LOGIN_THROTTLE } from "../src/login-throttle";

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
