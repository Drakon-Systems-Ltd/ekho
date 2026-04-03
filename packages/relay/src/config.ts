import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

function resolveNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  host: process.env.EKHO_HOST ?? "127.0.0.1",
  port: resolveNumber(process.env.EKHO_PORT, 4000),
  baseUrl: process.env.EKHO_BASE_URL ?? "http://127.0.0.1:4000",
  dbPath: path.resolve(process.env.EKHO_DB_PATH ?? path.join(__dirname, "..", "data", "ekho.sqlite")),
  operatorSessionSecret: process.env.EKHO_OPERATOR_SESSION_SECRET ?? "change-me",
  timestampSkewSeconds: resolveNumber(process.env.EKHO_TIMESTAMP_SKEW_SECONDS, 300),
  pollIntervalSeconds: resolveNumber(process.env.EKHO_POLL_INTERVAL_SECONDS, 5),
  heartbeatIntervalSeconds: resolveNumber(process.env.EKHO_HEARTBEAT_INTERVAL_SECONDS, 30),

  // Retry & dead-letter
  retryBackoffSeconds: [60, 300, 900, 3600, 7200] as readonly number[],
  maxRetries: 5,
  deliveryTimeoutSeconds: resolveNumber(process.env.EKHO_DELIVERY_TIMEOUT_SECONDS, 120),
  sweepIntervalMs: resolveNumber(process.env.EKHO_SWEEP_INTERVAL_MS, 30_000),

  // Rate limiting
  rateLimitWindowSeconds: resolveNumber(process.env.EKHO_RATE_LIMIT_WINDOW_SECONDS, 60),
  rateLimitMaxMessages: resolveNumber(process.env.EKHO_RATE_LIMIT_MAX_MESSAGES, 30),

  // Quarantine automation
  heartbeatLivenessThreshold: resolveNumber(process.env.EKHO_HEARTBEAT_LIVENESS_THRESHOLD, 3),
  heartbeatTimeoutSeconds: resolveNumber(process.env.EKHO_HEARTBEAT_TIMEOUT_SECONDS, 90),
  rateLimitViolationThreshold: resolveNumber(process.env.EKHO_RATE_LIMIT_VIOLATION_THRESHOLD, 5),
  rateLimitViolationWindowSeconds: resolveNumber(process.env.EKHO_RATE_LIMIT_VIOLATION_WINDOW_SECONDS, 3600)
} as const;
