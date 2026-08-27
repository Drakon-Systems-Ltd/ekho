// Tailnet gate (defense in depth): optionally require operator access to
// originate from the tailnet, verified via the identity header that
// `tailscale serve` injects on each proxied request. This binds "who can be the
// operator" to a Tailscale identity, independent of the password/token.
//
// Off by default (generic OSS) — opt in per deployment with
// EKHO_OPERATOR_REQUIRE_TAILNET=1 and optionally EKHO_OPERATOR_TAILNET_USER.
//
// TRUST BOUNDARY (#60): the identity headers are ordinary request headers — any
// client that can reach the bind address can set them. They are therefore only
// believed when the SOCKET PEER is one of the configured trusted proxies
// (EKHO_TRUSTED_PROXY_IPS, the same list the login throttle uses for
// X-Forwarded-For; default loopback, where `tailscale serve` terminates). A
// direct connection — which is what Docker/Helm's EKHO_HOST=0.0.0.0 exposes —
// fails the gate before any credential is processed, no matter what headers it
// carries. Fail-closed: an unparseable/absent peer address is untrusted.

import { config } from "./config";

/**
 * Normalise a socket address for comparison against the trusted-proxy list.
 * Node reports loopback as `127.0.0.1` or, on a dual-stack listener, as the
 * IPv4-mapped `::ffff:127.0.0.1`; both must match a `127.0.0.1` entry (and vice
 * versa) or Tailscale Serve on loopback would be locked out. Also strips an
 * IPv6 zone id and surrounding brackets, and lowercases hex.
 */
function normalizeIp(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  const withoutZone = raw.split("%")[0]!;
  const unbracketed =
    withoutZone.startsWith("[") && withoutZone.endsWith("]") ? withoutZone.slice(1, -1) : withoutZone;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(unbracketed);
  return mapped ? mapped[1]! : unbracketed;
}

/**
 * Whether the raw socket peer is a configured trusted proxy, i.e. a hop that is
 * allowed to speak for its client. Only such a peer may assert a tailnet
 * identity. Uses the existing EKHO_TRUSTED_PROXY_IPS list — one trust list for
 * the whole relay, not a second one to keep in sync.
 */
export function isTrustedTailnetPeer(
  socketIp: unknown,
  trustedProxies: readonly string[] = config.trustedProxyIps
): boolean {
  const peer = normalizeIp(socketIp);
  if (!peer) return false;
  return trustedProxies.some((entry) => normalizeIp(entry) === peer);
}

/**
 * Extract the Tailscale user login from request headers ("" if absent).
 * Raw read only — the value is untrusted until `evaluateTailnetGate` has
 * confirmed the peer that sent it.
 */
export function tailnetLoginFromHeaders(headers: Record<string, unknown>): string {
  const v = headers["tailscale-user-login"] ?? headers["tailscale-user-name"];
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return "";
}

/**
 * Decide whether a request passes the tailnet gate. Pure — unit-tested directly.
 * `peerTrusted` is required (not optional/defaulted) on purpose: a caller cannot
 * silently omit the peer check without failing to compile.
 */
export function evaluateTailnetGate(opts: {
  require: boolean;
  allowedUser: string;
  login: string;
  peerTrusted: boolean;
}): { allowed: boolean; reason?: string } {
  if (!opts.require) return { allowed: true };
  // Checked before the login itself: on a direct connection the header is
  // attacker-supplied, so its content is irrelevant.
  if (!opts.peerTrusted) return { allowed: false, reason: "tailnet identity required" };
  if (!opts.login) return { allowed: false, reason: "tailnet identity required" };
  if (opts.allowedUser && opts.login !== opts.allowedUser) {
    return { allowed: false, reason: "tailnet user not allowed" };
  }
  return { allowed: true };
}

/**
 * The gate as applied to a live request. Single entry point for both the login
 * route and requireOperatorAuth, so the peer check cannot be wired into one and
 * forgotten in the other. `ip` must be the RAW socket peer: Fastify's
 * `trustProxy` is deliberately left unset, so `request.ip` is exactly that.
 */
export function evaluateRequestTailnetGate(request: {
  ip: string;
  headers: Record<string, unknown>;
}): { allowed: boolean; reason?: string } {
  return evaluateTailnetGate({
    require: config.operatorRequireTailnet,
    allowedUser: config.operatorTailnetUser,
    login: tailnetLoginFromHeaders(request.headers),
    peerTrusted: isTrustedTailnetPeer(request.ip)
  });
}
