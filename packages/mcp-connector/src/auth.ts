// Request authentication and abuse limits for the HTTP surface.
//
// `Authenticator` is the seam: the static bearer and the OAuth 2.1 resource
// server both implement it, the router asks it one question per request, and
// the tools never see which one answered. Adding a third scheme later changes
// nothing above this file.

import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

export type AuthDecision =
  | { ok: true; subject: string }
  | { ok: false; status: 401; wwwAuthenticate: string; error: string; description: string };

export interface Authenticator {
  authenticate(authorizationHeader: string | undefined): AuthDecision | Promise<AuthDecision>;
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearerFromHeader(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * Constant-time string compare. Both sides are hashed first so the compare
 * runs over equal-length digests: timingSafeEqual throws on a length mismatch,
 * and the length of the configured secret must not leak through that either.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

export class StaticBearerAuthenticator implements Authenticator {
  constructor(private readonly token: string) {
    if (!token) throw new Error("bearer token must not be empty");
  }

  authenticate(header: string | undefined): AuthDecision {
    const presented = bearerFromHeader(header);
    if (presented && constantTimeEqual(presented, this.token)) return { ok: true, subject: "bearer" };
    return {
      ok: false,
      status: 401,
      wwwAuthenticate: 'Bearer realm="ekho-mcp"',
      error: presented ? "invalid_token" : "unauthorized",
      description: presented ? "the bearer token is not valid" : "a bearer token is required"
    };
  }
}

/**
 * Per-client token bucket: `perMinute` tokens, refilled continuously, so a
 * client can burst up to a minute's worth and then sustain one per
 * (60 / perMinute) seconds. Keys are bounded (LRU) so a flood of distinct
 * sources cannot grow memory without limit.
 */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = () => Date.now(),
    private readonly maxKeys = 10_000
  ) {}

  take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const t = this.now();
    const refillPerMs = this.perMinute / 60_000;
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.perMinute, updatedAt: t };
    } else {
      b.tokens = Math.min(this.perMinute, b.tokens + (t - b.updatedAt) * refillPerMs);
      b.updatedAt = t;
      this.buckets.delete(key); // re-insert as most recent
    }
    this.buckets.set(key, b);
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000)) };
  }
}

export class BodyTooLargeError extends Error {
  constructor(readonly cap: number) {
    super(`request body exceeds ${cap} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read a request body with a hard byte cap. A declared Content-Length over
 * the cap is refused before a byte is read; a chunked body is cut off the
 * moment it crosses the cap, and the socket is left to be destroyed by the
 * caller's 413 so the sender cannot keep streaming.
 */
export function readBodyCapped(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > cap) {
      reject(new BodyTooLargeError(cap));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > cap) {
        done = true;
        req.pause();
        reject(new BodyTooLargeError(cap));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

/**
 * The client key the rate limiter and the consent throttle bucket on.
 * X-Forwarded-For is honoured only when the operator says a proxy they
 * control sets it, and then only the entry that proxy appended is used: the
 * `hops`-th value from the RIGHT. Proxies append the peer address to whatever
 * XFF the client already sent, so the leftmost entries are client-controlled
 * and must never be used as a key. If the header holds fewer than `hops`
 * entries the chain is not the one the operator described and the socket
 * address is used instead.
 */
export function clientKey(req: IncomingMessage, trustProxy: boolean, hops = 1): string {
  if (trustProxy) {
    const raw = req.headers["x-forwarded-for"];
    const joined = Array.isArray(raw) ? raw.join(",") : raw ?? "";
    const parts = joined.split(",").map((s) => s.trim()).filter(Boolean);
    const depth = Number.isInteger(hops) && hops >= 1 ? hops : 1;
    if (parts.length >= depth) return parts[parts.length - depth]!;
  }
  return req.socket.remoteAddress ?? "unknown";
}
