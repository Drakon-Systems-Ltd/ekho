import { describe, it, expect } from "vitest";
import { securityHeaders, profileForResponse, requestIsSecure } from "../src/security-headers";

describe("securityHeaders", () => {
  it("never allows inline script in the console CSP (the XSS→token-theft path)", () => {
    const csp = securityHeaders("console", true)["Content-Security-Policy"]!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("allows exactly the external origins the console really loads (Google Fonts)", () => {
    const csp = securityHeaders("console", true)["Content-Security-Policy"]!;
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain("font-src 'self' data: https://fonts.gstatic.com");
    expect(csp).toContain("img-src 'self' data: blob:");
  });

  it("locks API responses down to nothing-loads", () => {
    const csp = securityHeaders("api", true)["Content-Security-Policy"]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("blocks framing and sniffing on both profiles", () => {
    for (const profile of ["console", "api"] as const) {
      const h = securityHeaders(profile, true);
      expect(h["X-Frame-Options"]).toBe("DENY");
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["Referrer-Policy"]).toBe("no-referrer");
      expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    }
  });

  it("upgrades insecure requests only over TLS, so a plain-HTTP deployment still loads", () => {
    expect(securityHeaders("console", true)["Content-Security-Policy"]).toContain("upgrade-insecure-requests");
    expect(securityHeaders("console", false)["Content-Security-Policy"]).not.toContain("upgrade-insecure-requests");
  });

  it("sends HSTS only over TLS — never on a plain-HTTP deployment", () => {
    expect(securityHeaders("console", true)["Strict-Transport-Security"]).toBe(
      "max-age=31536000; includeSubDomains"
    );
    expect(securityHeaders("console", false)["Strict-Transport-Security"]).toBeUndefined();
  });
});

describe("profileForResponse", () => {
  it("treats the UI and its SPA fallback as console", () => {
    expect(profileForResponse("/ui/", "text/html")).toBe("console");
    expect(profileForResponse("/ui/assets/index-abc.js", "text/javascript")).toBe("console");
    expect(profileForResponse("/ui", undefined)).toBe("console");
    expect(profileForResponse("/anything", "text/html; charset=utf-8")).toBe("console");
  });

  it("treats API/JSON/metrics as api", () => {
    expect(profileForResponse("/metrics", "text/plain")).toBe("api");
    expect(profileForResponse("/v1/operator/overview", "application/json")).toBe("api");
    expect(profileForResponse("/.well-known/agent-card.json", "application/json")).toBe("api");
  });

  it("ignores the query string when classifying", () => {
    expect(profileForResponse("/ui/?tab=health", "text/html")).toBe("console");
  });

  it("does not let a lookalike path masquerade as the console", () => {
    expect(profileForResponse("/uixyz", "application/json")).toBe("api");
  });
});

describe("requestIsSecure", () => {
  it("trusts the TLS-terminating proxy's forwarded proto", () => {
    expect(requestIsSecure({ "x-forwarded-proto": "https" }, "http")).toBe(true);
    expect(requestIsSecure({ "x-forwarded-proto": "http" }, "http")).toBe(false);
  });

  it("reads the client-most hop of a forwarded chain", () => {
    expect(requestIsSecure({ "x-forwarded-proto": "https, http" }, "http")).toBe(true);
    expect(requestIsSecure({ "x-forwarded-proto": ["https"] }, "http")).toBe(true);
  });

  it("falls back to the socket protocol when unproxied", () => {
    expect(requestIsSecure({}, "https")).toBe(true);
    expect(requestIsSecure({}, "http")).toBe(false);
  });
});
