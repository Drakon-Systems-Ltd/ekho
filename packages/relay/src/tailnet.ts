// Tailnet gate (defense in depth): optionally require operator access to
// originate from the tailnet, verified via the identity header that
// `tailscale serve` injects on each proxied request. This binds "who can be the
// operator" to a Tailscale identity, independent of the password/token.
//
// Off by default (generic OSS) — opt in per deployment with
// EKHO_OPERATOR_REQUIRE_TAILNET=1 and optionally EKHO_OPERATOR_TAILNET_USER.

/** Extract the Tailscale user login from request headers ("" if absent). */
export function tailnetLoginFromHeaders(headers: Record<string, unknown>): string {
  const v = headers["tailscale-user-login"] ?? headers["tailscale-user-name"];
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return "";
}

/** Decide whether a request passes the tailnet gate. Pure — unit-tested directly. */
export function evaluateTailnetGate(opts: {
  require: boolean;
  allowedUser: string;
  login: string;
}): { allowed: boolean; reason?: string } {
  if (!opts.require) return { allowed: true };
  if (!opts.login) return { allowed: false, reason: "tailnet identity required" };
  if (opts.allowedUser && opts.login !== opts.allowedUser) {
    return { allowed: false, reason: "tailnet user not allowed" };
  }
  return { allowed: true };
}
