import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { registerSecurityHeaders } from "../src/security-headers";

// The pure header set is covered in security-headers.test.ts. This file proves
// the HOOK is actually wired: that real responses — JSON, HTML, errors, 404s —
// carry the headers, and that a route with its own stricter CSP keeps it.
describe("security headers are applied to real responses", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = fastify();
    registerSecurityHeaders(app);
    app.get("/v1/thing", async () => ({ ok: true }));
    app.get("/ui/", async (_req, reply) => reply.type("text/html").send("<!doctype html><html></html>"));
    app.get("/boom", async () => { throw new Error("kaboom"); });
    // Mirrors the attachment download route, which sets a stricter CSP itself.
    app.get("/v1/attachments/:id", async (_req, reply) =>
      reply.header("Content-Security-Policy", "default-src 'none'; sandbox").send("bytes")
    );
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  it("sets the API profile on a JSON response", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/thing" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["permissions-policy"]).toContain("camera=()");
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
  });

  it("sets the console profile on the UI, allowing its bundle but not inline script", async () => {
    const res = await app.inject({ method: "GET", url: "/ui/" });
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("still protects error responses", async () => {
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toBeTruthy();
  });

  it("still protects framework-generated 404s", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toBeTruthy();
  });

  it("never loosens a route's own stricter CSP (attachment sandbox survives)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/attachments/abc" });
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    // The rest of the baseline still applies.
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("emits HSTS only when the request arrived over TLS", async () => {
    const plain = await app.inject({ method: "GET", url: "/v1/thing" });
    expect(plain.headers["strict-transport-security"]).toBeUndefined();

    const proxied = await app.inject({
      method: "GET",
      url: "/v1/thing",
      headers: { "x-forwarded-proto": "https" }
    });
    expect(proxied.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  });
});
