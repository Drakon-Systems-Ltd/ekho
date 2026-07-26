// Baseline HTTP security headers for every relay response.
//
// The relay's own auth, crypto and input handling are strong, but until now it
// emitted no browser-facing security headers at all. That matters because the
// operator console is a real browser app holding a bearer token: without a CSP
// an injected script can read that token, and without frame-ancestors the
// console is clickjackable into issuing operator control actions.
//
// Two profiles, chosen per response:
//   - "console": the React UI. Needs its own bundle, inline style attributes
//     (React) and the Google Fonts stylesheet/woff2 it loads. Crucially it has
//     NO inline <script>, so script-src stays 'self' with no 'unsafe-inline' —
//     the directive that actually stops token-stealing XSS.
//   - "api": everything else (JSON, metrics, agent-card). Nothing should ever
//     execute or embed, so it locks down to default-src 'none'.
//
// HSTS is emitted only for requests that actually arrived over TLS. Emitting it
// unconditionally would pin a plain-HTTP dev/localhost deployment to https and
// make it unreachable.

import type { FastifyInstance } from "fastify";

export type SecurityHeaderProfile = "console" | "api";

/**
 * The console's CSP. Split out so the exact directives are unit-testable.
 *
 * `upgrade-insecure-requests` is appended only for requests that already
 * arrived over TLS. Emitting it unconditionally would tell a browser loading a
 * plain-HTTP deployment (a LAN IP, say) to upgrade its own asset requests to
 * https, which that deployment cannot serve — a self-inflicted outage.
 */
const CONSOLE_CSP_BASE = [
  "default-src 'self'",
  // No inline <script> exists in the built index.html, so no 'unsafe-inline'
  // here — this is the directive that stops an injected script reading the
  // operator token out of localStorage.
  "script-src 'self'",
  // React sets inline style attributes and index.html carries an inline <style>,
  // so style-src must allow inline. Far lower risk than script inline.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // Attachment thumbnails render from same-origin blob/data URLs.
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

/** The console CSP for a given transport. */
function consoleCsp(secure: boolean): string {
  return secure ? `${CONSOLE_CSP_BASE}; upgrade-insecure-requests` : CONSOLE_CSP_BASE;
}

/** Locked-down CSP for non-UI responses — nothing loads, nothing frames. */
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * The baseline header set for a response. Pure so it can be asserted directly.
 *
 * @param profile  which CSP to apply
 * @param secure   true when the request reached us over TLS (directly or via a
 *                 TLS-terminating proxy) — gates HSTS
 */
export function securityHeaders(profile: SecurityHeaderProfile, secure: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": profile === "console" ? consoleCsp(secure) : API_CSP,
    // Clickjacking defence for browsers predating frame-ancestors.
    "X-Frame-Options": "DENY",
    // Stop MIME sniffing turning an uploaded/echoed body into script.
    "X-Content-Type-Options": "nosniff",
    // Don't leak console URLs (which carry ids) to third parties.
    "Referrer-Policy": "no-referrer",
    // The console needs none of these device capabilities.
    "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    // Isolate the browsing context from cross-origin popups/embeds.
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    // Legacy header, still honoured by some proxies/older engines.
    "X-Permitted-Cross-Domain-Policies": "none"
  };
  if (secure) {
    // 1 year, subdomains included. Only ever sent over a TLS request.
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

/**
 * Whether a response should get the console profile: the served UI itself, or
 * the SPA fallback (both are HTML). Everything else is API.
 */
export function profileForResponse(url: string, contentType: string | undefined): SecurityHeaderProfile {
  const path = String(url ?? "").split("?")[0] ?? "";
  if (path === "/ui" || path.startsWith("/ui/")) return "console";
  if (String(contentType ?? "").toLowerCase().includes("text/html")) return "console";
  return "api";
}

/**
 * Whether the original client request was over TLS. The relay usually runs
 * plain HTTP behind a TLS-terminating proxy (tailscale serve / funnel), so the
 * forwarded-proto header is authoritative there; fall back to the socket.
 */
export function requestIsSecure(headers: Record<string, unknown>, protocol: string | undefined): boolean {
  const fwd = headers["x-forwarded-proto"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  if (typeof first === "string" && first.length > 0) {
    // A proxy may forward a comma-separated chain; the client-most hop is first.
    return first.split(",")[0]!.trim().toLowerCase() === "https";
  }
  return String(protocol ?? "").toLowerCase() === "https";
}

/**
 * Apply the baseline headers to EVERY response — static files, JSON, errors and
 * framework-generated 404s alike. Registered as onSend so nothing escapes it.
 *
 * A route that already set its own Content-Security-Policy keeps it: the
 * attachment download path deliberately serves `default-src 'none'; sandbox`,
 * which is stricter than either profile here, and must not be loosened.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    const profile = profileForResponse(request.url, String(reply.getHeader("content-type") ?? ""));
    const secure = requestIsSecure(request.headers as Record<string, unknown>, request.protocol);
    for (const [name, value] of Object.entries(securityHeaders(profile, secure))) {
      if (name === "Content-Security-Policy" && reply.getHeader("content-security-policy")) continue;
      reply.header(name, value);
    }
    return payload;
  });
}
