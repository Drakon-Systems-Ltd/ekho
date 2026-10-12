// Phase-2 seam: wake a Grok automation when messages arrive. Off unless
// EKHO_MCP_WAKE_WEBHOOK_URL is set. Signed per Standard Webhooks
// (https://www.standardwebhooks.com): HMAC-SHA256 over
// `${id}.${timestamp}.${payload}`, headers webhook-id / webhook-timestamp /
// webhook-signature, the secret given as `whsec_<base64>` (or a raw string).
//
// Delivery policy: debounced (never more than one POST per `debounceMs`,
// events coalesce into one payload), three attempts with exponential backoff,
// and a circuit breaker that stops attempts for a cooling period after
// repeated failure so a dead endpoint cannot keep the connector busy.

import crypto from "node:crypto";
import type { StoredMessage } from "./store.js";

export const WEBHOOK_SECRET_PREFIX = "whsec_";
export const PREVIEW_MAX = 5;
export const SNIPPET_MAX = 140;

export function decodeWebhookSecret(secret: string): Buffer {
  if (secret.startsWith(WEBHOOK_SECRET_PREFIX)) return Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), "base64");
  return Buffer.from(secret, "utf8");
}

/** `v1,<base64 HMAC-SHA256>` over `${msgId}.${timestamp}.${payload}`. */
export function standardWebhookSignature(secret: string, msgId: string, timestampSeconds: number, payload: string): string {
  const mac = crypto.createHmac("sha256", decodeWebhookSecret(secret)).update(`${msgId}.${timestampSeconds}.${payload}`, "utf8").digest("base64");
  return `v1,${mac}`;
}

export function signWebhookHeaders(
  secret: string,
  payload: string,
  opts: { id?: string; timestampSeconds?: number } = {}
): Record<string, string> {
  const id = opts.id ?? `msg_${crypto.randomBytes(12).toString("base64url")}`;
  const ts = opts.timestampSeconds ?? Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": standardWebhookSignature(secret, id, ts, payload)
  };
}

export interface WakePayload {
  type: "ekho.message";
  agent: string;
  count: number;
  preview: Array<{ from: string; conversation_id: string; snippet: string }>;
}

export interface WakeNotifierOptions {
  url: string;
  secret: string;
  agentName: string;
  debounceMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  log?: { warn?: (...a: unknown[]) => void; info?: (...a: unknown[]) => void };
  maxAttempts?: number;
  backoffMs?: number[];
  breakerThreshold?: number;
  breakerOpenMs?: number;
}

export class WakeNotifier {
  private pending: StoredMessage[] = [];
  private timerArmed = false;
  private lastSentAt = -Infinity;
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  private sending: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly backoffMs: number[];
  private readonly breakerThreshold: number;
  private readonly breakerOpenMs: number;
  /** Counters an operator can read off /healthz. */
  readonly stats = { sent: 0, failed: 0, dropped_breaker_open: 0 };

  constructor(private readonly opts: WakeNotifierOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffMs = opts.backoffMs ?? [1000, 4000, 16000];
    this.breakerThreshold = opts.breakerThreshold ?? 5;
    this.breakerOpenMs = opts.breakerOpenMs ?? 5 * 60_000;
  }

  /** Queue messages for the next (debounced) wake. Returns immediately. */
  notify(messages: StoredMessage[]): void {
    if (messages.length === 0) return;
    this.pending.push(...messages);
    if (this.timerArmed) return;
    this.timerArmed = true;
    const wait = Math.max(0, this.lastSentAt + this.opts.debounceMs - this.now());
    this.setTimer(() => {
      this.timerArmed = false;
      this.sending = this.flushNow().finally(() => {
        this.sending = null;
      });
    }, wait);
  }

  /** Await an in-flight delivery (tests, shutdown). */
  async settle(): Promise<void> {
    if (this.sending) await this.sending;
  }

  breakerOpen(): boolean {
    return this.breakerOpenUntil > this.now();
  }

  buildPayload(messages: StoredMessage[]): WakePayload {
    return {
      type: "ekho.message",
      agent: this.opts.agentName,
      count: messages.length,
      preview: messages.slice(0, PREVIEW_MAX).map((m) => ({
        from: m.sender_label,
        conversation_id: m.conversation_id,
        snippet: m.text.length > SNIPPET_MAX ? `${m.text.slice(0, SNIPPET_MAX - 1)}…` : m.text
      }))
    };
  }

  /** Deliver whatever is pending now (honouring the breaker), with retries. */
  async flushNow(): Promise<void> {
    const batch = this.pending.splice(0);
    if (batch.length === 0) return;
    if (this.breakerOpen()) {
      this.stats.dropped_breaker_open += batch.length;
      this.opts.log?.warn?.(`[ekho-mcp] wake webhook breaker open; dropped a wake for ${batch.length} message(s)`);
      return;
    }
    this.lastSentAt = this.now();
    const payload = JSON.stringify(this.buildPayload(batch));
    let lastError = "";
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) await this.sleep(this.backoffMs[Math.min(attempt - 1, this.backoffMs.length - 1)]);
      try {
        const res = await this.fetchImpl(this.opts.url, {
          method: "POST",
          headers: signWebhookHeaders(this.opts.secret, payload),
          body: payload
        });
        if (res.ok) {
          this.consecutiveFailures = 0;
          this.stats.sent += 1;
          return;
        }
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = String(err);
      }
    }
    this.stats.failed += 1;
    this.consecutiveFailures += 1;
    this.opts.log?.warn?.(`[ekho-mcp] wake webhook failed after ${this.maxAttempts} attempt(s): ${lastError}`);
    if (this.consecutiveFailures >= this.breakerThreshold) {
      this.breakerOpenUntil = this.now() + this.breakerOpenMs;
      this.consecutiveFailures = 0;
      this.opts.log?.warn?.(`[ekho-mcp] wake webhook breaker OPEN for ${Math.round(this.breakerOpenMs / 1000)} s`);
    }
  }
}
