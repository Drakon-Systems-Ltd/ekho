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

// Resolve the DB path once so dbPath and attachmentsDir always share a parent.
const dbPath = path.resolve(process.env.EKHO_DB_PATH ?? path.join(__dirname, "..", "data", "ekho.sqlite"));

export const config = {
  host: process.env.EKHO_HOST ?? "127.0.0.1",
  port: resolveNumber(process.env.EKHO_PORT, 4000),
  baseUrl: process.env.EKHO_BASE_URL ?? "http://127.0.0.1:4000",
  dbPath,
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
  rateLimitViolationWindowSeconds: resolveNumber(process.env.EKHO_RATE_LIMIT_VIOLATION_WINDOW_SECONDS, 3600),

  // Licensing
  licenseKey: process.env.EKHO_LICENSE_KEY as string | undefined,
  licensePath: process.env.EKHO_LICENSE_PATH as string | undefined,

  // ShieldCortex integration
  shieldcortexPath: process.env.EKHO_SHIELDCORTEX_PATH as string | undefined,
  shieldcortexProfile: (process.env.EKHO_SHIELDCORTEX_PROFILE ?? "balanced") as "strict" | "balanced" | "permissive",

  // TLS (optional — omit to serve plain HTTP behind a TLS-terminating proxy)
  tlsCertPath: process.env.EKHO_TLS_CERT_PATH as string | undefined,
  tlsKeyPath: process.env.EKHO_TLS_KEY_PATH as string | undefined,

  // File attachments
  attachmentsDir: process.env.EKHO_ATTACHMENTS_DIR
    ? path.resolve(process.env.EKHO_ATTACHMENTS_DIR)
    : path.join(path.dirname(dbPath), "attachments"),
  attachmentMaxBytes: resolveNumber(process.env.EKHO_ATTACHMENT_MAX_BYTES, 25 * 1024 * 1024), // 25 MiB
  attachmentMaxPerMessage: resolveNumber(process.env.EKHO_ATTACHMENT_MAX_PER_MESSAGE, 10)
} as const;

// base64 inflates by 4/3; add headroom for the JSON envelope + filename/mime fields.
export const ATTACHMENT_UPLOAD_BODY_LIMIT = Math.ceil(config.attachmentMaxBytes * 4 / 3) + 64 * 1024;

/** True when the operator session secret is unset or the shipped default. */
export function isInsecureSecret(secret: string): boolean {
  return !secret || secret === "change-me";
}

/**
 * Refuse to run with an unset or default operator session secret — a default
 * secret means anyone can forge an operator session token. Local development
 * can opt out with EKHO_DEV_INSECURE=1.
 */
export function assertOperatorSecret(secret: string, allowInsecure: boolean): void {
  if (isInsecureSecret(secret) && !allowInsecure) {
    throw new Error(
      "EKHO_OPERATOR_SESSION_SECRET is unset or set to the insecure default 'change-me'. " +
        "Generate a strong secret with `openssl rand -hex 32` and set it via the environment. " +
        "For local development only, set EKHO_DEV_INSECURE=1 to bypass this check."
    );
  }
}
