// Configuration from the environment. Every knob is an EKHO_* / EKHO_MCP_*
// variable so a systemd unit's EnvironmentFile is the whole configuration;
// nothing is read from the repository or from argv.

import os from "node:os";
import path from "node:path";
import { parseRequireSignedMode, type RequireSignedMode } from "@drakon-systems/ekho-sdk/identity";

export type AuthMode = "bearer" | "oauth";

export interface ConnectorConfig {
  relayBaseUrl: string;
  fleetId?: string;
  enrollmentToken?: string;
  displayName: string;
  stateDir: string;
  requireSigned: RequireSignedMode;
  pollIntervalSeconds?: number;
  heartbeatIntervalSeconds?: number;
  queueMax: number;

  mcpPath: string;
  host: string;
  port: number;
  /** Public origin clients reach this connector at (e.g. a Tailscale Funnel
   *  hostname). Required in oauth mode: it is the resource identifier and the
   *  authorization server's issuer. */
  publicUrl?: string;
  /** Trust X-Forwarded-For for the per-client rate limit. Off by default: the
   *  only safe setting unless a proxy you control sits in front. */
  trustProxy: boolean;

  auth: AuthMode;
  bearer?: string;
  oauthPassword?: string;
  /** Lowercase hostnames a dynamically registered client may redirect to.
   *  Empty = any https host (loopback http always allowed). */
  oauthAllowedRedirectHosts: string[];

  rateLimitPerMinute: number;
  bodyCapBytes: number;

  wakeWebhookUrl?: string;
  wakeWebhookSecret?: string;
  wakeDebounceMs: number;
}

export const DEFAULTS = {
  displayName: "Grok",
  stateDir: path.join(os.homedir(), ".ekho-mcp"),
  mcpPath: "/ekho-mcp",
  host: "127.0.0.1",
  port: 4100,
  auth: "oauth" as AuthMode,
  rateLimitPerMinute: 60,
  bodyCapBytes: 64 * 1024,
  queueMax: 500,
  wakeDebounceMs: 30_000
};

/** The debounce floor the brief fixes: a wake webhook never fires more often. */
export const MIN_WAKE_DEBOUNCE_MS = 30_000;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function str(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`);
  }
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string): boolean {
  const v = str(env, key)?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function normalizePath(p: string): string {
  const withSlash = p.startsWith("/") ? p : `/${p}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

function normalizeOrigin(url: string, key: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`${key} must be an absolute URL, got ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigError(`${key} must be http(s), got ${parsed.protocol}`);
  }
  // Origin + any path prefix, no trailing slash, no query/hash.
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  const relayBaseUrl = str(env, "EKHO_RELAY_BASE_URL");
  if (!relayBaseUrl) throw new ConfigError("EKHO_RELAY_BASE_URL is required");

  const auth = (str(env, "EKHO_MCP_AUTH") ?? DEFAULTS.auth).toLowerCase();
  if (auth !== "bearer" && auth !== "oauth") {
    throw new ConfigError(`EKHO_MCP_AUTH must be "bearer" or "oauth", got ${JSON.stringify(auth)}`);
  }
  const bearer = str(env, "EKHO_MCP_BEARER");
  const oauthPassword = str(env, "EKHO_MCP_OAUTH_PASSWORD");
  const publicUrlRaw = str(env, "EKHO_MCP_PUBLIC_URL");
  const publicUrl = publicUrlRaw ? normalizeOrigin(publicUrlRaw, "EKHO_MCP_PUBLIC_URL") : undefined;
  if (auth === "bearer") {
    if (!bearer || bearer.length < 32) {
      throw new ConfigError("EKHO_MCP_BEARER is required in bearer mode and must be at least 32 characters");
    }
  } else {
    if (!oauthPassword || oauthPassword.length < 12) {
      throw new ConfigError("EKHO_MCP_OAUTH_PASSWORD is required in oauth mode and must be at least 12 characters");
    }
    if (!publicUrl) throw new ConfigError("EKHO_MCP_PUBLIC_URL is required in oauth mode (the resource / issuer URL)");
  }

  const wakeWebhookUrl = str(env, "EKHO_MCP_WAKE_WEBHOOK_URL");
  const wakeWebhookSecret = str(env, "EKHO_MCP_WAKE_WEBHOOK_SECRET");
  if (wakeWebhookUrl && !wakeWebhookSecret) {
    throw new ConfigError("EKHO_MCP_WAKE_WEBHOOK_SECRET is required when EKHO_MCP_WAKE_WEBHOOK_URL is set");
  }
  if (wakeWebhookUrl) normalizeOrigin(wakeWebhookUrl, "EKHO_MCP_WAKE_WEBHOOK_URL");

  const poll = str(env, "EKHO_MCP_POLL_INTERVAL_SECONDS");
  const hb = str(env, "EKHO_MCP_HEARTBEAT_INTERVAL_SECONDS");

  return {
    relayBaseUrl: relayBaseUrl.replace(/\/+$/, ""),
    fleetId: str(env, "EKHO_FLEET_ID"),
    enrollmentToken: str(env, "EKHO_ENROLLMENT_TOKEN"),
    displayName: str(env, "EKHO_MCP_DISPLAY_NAME") ?? DEFAULTS.displayName,
    stateDir: path.resolve(str(env, "EKHO_MCP_STATE_DIR") ?? DEFAULTS.stateDir),
    requireSigned: parseRequireSignedMode(str(env, "EKHO_REQUIRE_SIGNED")),
    pollIntervalSeconds: poll ? int(env, "EKHO_MCP_POLL_INTERVAL_SECONDS", 5, 1, 3600) : undefined,
    heartbeatIntervalSeconds: hb ? int(env, "EKHO_MCP_HEARTBEAT_INTERVAL_SECONDS", 30, 5, 3600) : undefined,
    queueMax: int(env, "EKHO_MCP_QUEUE_MAX", DEFAULTS.queueMax, 10, 100_000),

    mcpPath: normalizePath(str(env, "EKHO_MCP_PATH") ?? DEFAULTS.mcpPath),
    host: str(env, "EKHO_MCP_BIND") ?? DEFAULTS.host,
    port: int(env, "EKHO_MCP_PORT", DEFAULTS.port, 0, 65535),
    publicUrl,
    trustProxy: bool(env, "EKHO_MCP_TRUST_PROXY"),

    auth,
    bearer,
    oauthPassword,
    oauthAllowedRedirectHosts: (str(env, "EKHO_MCP_OAUTH_ALLOWED_REDIRECT_HOSTS") ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),

    rateLimitPerMinute: int(env, "EKHO_MCP_RATE_LIMIT_PER_MINUTE", DEFAULTS.rateLimitPerMinute, 1, 100_000),
    bodyCapBytes: int(env, "EKHO_MCP_BODY_CAP_BYTES", DEFAULTS.bodyCapBytes, 1024, 16 * 1024 * 1024),

    wakeWebhookUrl,
    wakeWebhookSecret,
    wakeDebounceMs: Math.max(
      MIN_WAKE_DEBOUNCE_MS,
      int(env, "EKHO_MCP_WAKE_DEBOUNCE_MS", DEFAULTS.wakeDebounceMs, 1, 24 * 3600 * 1000)
    )
  };
}
