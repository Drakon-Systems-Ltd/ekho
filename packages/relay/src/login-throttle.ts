// Brute-force throttle for operator login.
//
// The operator password is the single credential guarding the whole control
// plane, and /v1/operator/login had no attempt limit: an attacker who could
// reach the relay could guess passwords as fast as scrypt would answer. The
// existing rate limiter only covers agent MESSAGE sends, so it never applied
// here.
//
// Two independent counters per attempt, because either one alone is evadable:
//   - account (fleet + email): stops a slow distributed grind on one operator
//   - client IP:              stops one host spraying many accounts
// Whichever trips first blocks the attempt.
//
// Failures decay on a rolling window rather than latching, and a successful
// login clears the account counter — so a legitimate operator who mistypes a
// few times is never locked out for long, and an attacker cannot permanently
// lock a real operator out by burning attempts (the window simply expires).
//
// State is in-memory: it resets if the relay restarts, which is acceptable
// because an attacker cannot induce a restart, and it keeps this off the hot
// DB path. Persistence would only matter for forensics, and failures are
// already recorded as relay events by the caller.

import { config } from "./config";

/**
 * The client address the throttle should key on. `socketIp` is what the TCP
 * peer actually is; behind `tailscale serve` that is always the proxy's
 * loopback, which collapsed every operator into one shared bucket (#8).
 *
 * Trust model: only when the socket itself is a configured trusted proxy do we
 * read X-Forwarded-For, and then only the RIGHTMOST entry — the one our single
 * trusted hop appended. Everything left of it, and the entire header on a
 * direct connection, is attacker-controlled and ignored, so a spoofed header
 * can never rotate an attacker out of their own bucket.
 */
export function resolveClientIp(
  socketIp: string,
  forwardedFor: unknown,
  trustedProxies: readonly string[] = config.trustedProxyIps
): string {
  const sock = String(socketIp ?? "").trim();
  if (!trustedProxies.includes(sock)) return sock;
  // Repeated headers arrive as an array; the proxy appends to the last one.
  const rawHeader = Array.isArray(forwardedFor) ? forwardedFor[forwardedFor.length - 1] : forwardedFor;
  if (typeof rawHeader !== "string") return sock;
  const parts = rawHeader.split(",");
  const client = parts[parts.length - 1]!.trim();
  return client.length > 0 ? client : sock;
}

export interface ThrottleDecision {
  allowed: boolean;
  /** Seconds until the caller may retry — set only when blocked. */
  retryAfterSeconds?: number;
}

interface Bucket {
  failures: number;
  /** Epoch ms when this bucket's window expires and the count resets. */
  resetAt: number;
}

export interface LoginThrottleOptions {
  /** Failures allowed within the window before blocking. */
  maxFailures: number;
  /** Rolling window length in seconds. */
  windowSeconds: number;
}

/** Deployment-configurable limits (EKHO_LOGIN_MAX_FAILURES / _WINDOW_SECONDS). */
export const DEFAULT_LOGIN_THROTTLE: LoginThrottleOptions = {
  maxFailures: config.loginMaxFailures,
  windowSeconds: config.loginWindowSeconds
};

/**
 * A pair of rolling failure counters. Deliberately a class with an injectable
 * clock so the expiry behaviour is unit-testable without waiting.
 */
export class LoginThrottle {
  private buckets = new Map<string, Bucket>();

  constructor(
    private opts: LoginThrottleOptions = DEFAULT_LOGIN_THROTTLE,
    private now: () => number = () => Date.now()
  ) {}

  /** Normalised counter keys for an attempt. Email is case-insensitive. */
  static keysFor(fleetName: string, email: string, ip: string): string[] {
    return [
      `acct:${String(fleetName ?? "").trim().toLowerCase()}|${String(email ?? "").trim().toLowerCase()}`,
      `ip:${String(ip ?? "").trim()}`
    ];
  }

  /** Whether this attempt may proceed. Does NOT record anything. */
  check(fleetName: string, email: string, ip: string): ThrottleDecision {
    const t = this.now();
    let worstRetry = 0;
    for (const key of LoginThrottle.keysFor(fleetName, email, ip)) {
      const bucket = this.buckets.get(key);
      if (!bucket) continue;
      if (bucket.resetAt <= t) {
        this.buckets.delete(key); // window expired — forget it
        continue;
      }
      if (bucket.failures >= this.opts.maxFailures) {
        worstRetry = Math.max(worstRetry, Math.ceil((bucket.resetAt - t) / 1000));
      }
    }
    return worstRetry > 0 ? { allowed: false, retryAfterSeconds: worstRetry } : { allowed: true };
  }

  /** Record a failed attempt against both counters. */
  recordFailure(fleetName: string, email: string, ip: string): void {
    const t = this.now();
    for (const key of LoginThrottle.keysFor(fleetName, email, ip)) {
      const bucket = this.buckets.get(key);
      if (!bucket || bucket.resetAt <= t) {
        // Start a fresh window on first failure (or after one expired).
        this.buckets.set(key, { failures: 1, resetAt: t + this.opts.windowSeconds * 1000 });
      } else {
        bucket.failures += 1;
      }
    }
  }

  /**
   * Clear the ACCOUNT counter after a successful login. The IP counter is left
   * alone on purpose: one valid login must not wipe the evidence of a spray
   * against other accounts from the same host.
   */
  recordSuccess(fleetName: string, email: string): void {
    this.buckets.delete(LoginThrottle.keysFor(fleetName, email, "")[0]!);
  }

  /** Drop expired buckets so the map can't grow without bound. */
  sweep(): void {
    const t = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= t) this.buckets.delete(key);
    }
  }

  /** Test/introspection helper. */
  size(): number {
    return this.buckets.size;
  }
}

/** The relay's shared instance. */
export const loginThrottle = new LoginThrottle();
