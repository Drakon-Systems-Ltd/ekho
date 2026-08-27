import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";
import { config } from "../src/config";

// #60: EKHO_OPERATOR_REQUIRE_TAILNET used to trust the `tailscale-user-login` /
// `tailscale-user-name` headers unconditionally. Those are ordinary request
// headers, so any client that could reach the bind address (Docker/Helm ship
// EKHO_HOST=0.0.0.0) could set one and pass a gate documented as rejecting
// off-tailnet requests before credentials are processed.
//
// These tests pin the trust boundary: the identity is only believed when the
// SOCKET PEER is a configured trusted proxy (EKHO_TRUSTED_PROXY_IPS, default
// loopback — where `tailscale serve` terminates). Delete the peer check and
// every "spoofed" case below flips to allowed.
describe("tailnet gate verifies the peer (#60)", () => {
  let relay: TestRelay;

  const SPOOFED = { "tailscale-user-login": "operator@tailnet.example" };
  // Synthetic off-tailnet client (RFC 5737 documentation range).
  const UNTRUSTED = "198.51.100.7";

  beforeEach(async () => {
    relay = await createTestRelay();
    config.operatorRequireTailnet = true;
    config.operatorTailnetUser = "";
  });

  afterEach(() => {
    config.operatorRequireTailnet = false;
    config.operatorTailnetUser = "";
    relay.cleanup();
  });

  const login = (opts: { remoteAddress: string; headers?: Record<string, string>; password?: string }) =>
    relay.app.inject({
      method: "POST",
      url: "/v1/operator/login",
      remoteAddress: opts.remoteAddress,
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      payload: {
        fleet_name: relay.fleetName,
        email: relay.operatorEmail,
        password: opts.password ?? "testpassword1"
      }
    });

  const overview = (opts: { remoteAddress: string; headers?: Record<string, string> }) =>
    relay.app.inject({
      method: "GET",
      url: "/v1/operator/overview",
      remoteAddress: opts.remoteAddress,
      headers: { authorization: `Bearer ${relay.operatorToken}`, ...(opts.headers ?? {}) }
    });

  it("rejects a spoofed identity header from an untrusted address on login", async () => {
    const res = await login({ remoteAddress: UNTRUSTED, headers: SPOOFED });
    expect(res.statusCode).toBe(403);
    // The credentials were valid: proof the gate ran before they were processed.
    expect(JSON.parse(res.body).token).toBeUndefined();
  });

  it("rejects a spoofed identity header from an untrusted address on an authenticated route", async () => {
    const res = await overview({ remoteAddress: UNTRUSTED, headers: SPOOFED });
    expect(res.statusCode).toBe(403);
  });

  it("rejects the alternate tailscale-user-name header from an untrusted address", async () => {
    const res = await overview({
      remoteAddress: UNTRUSTED,
      headers: { "tailscale-user-name": "operator@tailnet.example" }
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects an untrusted peer that also spoofs X-Forwarded-For as the proxy", async () => {
    // Forwarding headers cannot promote a client into the trusted-peer set.
    const res = await overview({
      remoteAddress: UNTRUSTED,
      headers: { ...SPOOFED, "x-forwarded-for": "127.0.0.1" }
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows the identity when it arrives via the trusted loopback proxy", async () => {
    const loggedIn = await login({ remoteAddress: "127.0.0.1", headers: SPOOFED });
    expect(loggedIn.statusCode).toBe(200);
    expect(JSON.parse(loggedIn.body).token).toBeTruthy();

    const res = await overview({ remoteAddress: "127.0.0.1", headers: SPOOFED });
    expect(res.statusCode).toBe(200);
  });

  it("allows the identity from an IPv4-mapped loopback peer", async () => {
    // A dual-stack listener reports the Serve hop as ::ffff:127.0.0.1.
    const res = await overview({ remoteAddress: "::ffff:127.0.0.1", headers: SPOOFED });
    expect(res.statusCode).toBe(200);
  });

  it("still requires an identity from the trusted proxy itself", async () => {
    const res = await overview({ remoteAddress: "127.0.0.1" });
    expect(res.statusCode).toBe(403);
  });

  it("still enforces the user allowlist over the trusted proxy", async () => {
    config.operatorTailnetUser = "operator@tailnet.example";
    const ok = await overview({ remoteAddress: "127.0.0.1", headers: SPOOFED });
    expect(ok.statusCode).toBe(200);
    const bad = await overview({
      remoteAddress: "127.0.0.1",
      headers: { "tailscale-user-login": "intruder@tailnet.example" }
    });
    expect(bad.statusCode).toBe(403);
  });

  it("does not gate an untrusted peer when the gate is off", async () => {
    config.operatorRequireTailnet = false;
    const res = await overview({ remoteAddress: UNTRUSTED });
    expect(res.statusCode).toBe(200);
  });
});
