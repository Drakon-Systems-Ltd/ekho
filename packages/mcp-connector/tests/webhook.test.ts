import { describe, it, expect } from "vitest";
import { WakeNotifier, decodeWebhookSecret, signWebhookHeaders, standardWebhookSignature } from "../src/webhook";
import type { StoredMessage } from "../src/store";

// The Standard Webhooks reference vector (standardwebhooks.com, "Verifying
// signatures"), recomputed independently with Python's hmac before this test
// was written: both say v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=.
const VECTOR = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  payload: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="
};

function msg(id: string, text = "hello"): StoredMessage {
  return {
    message_id: id, conversation_id: "conv", direction: "in", sender_agent_id: "a", sender_label: "Jarvis", sender_kind: "agent",
    message_type: "direct", priority: "normal", text, attachments: [], mentions: [], reply_to: null, room: null,
    verification: { status: "verified", reason: null, key_id: "k" }, sent_at: "t", stored_at: "t", delivered_cursor: null
  };
}

describe("Standard Webhooks signer", () => {
  it("reproduces the reference vector", () => {
    expect(standardWebhookSignature(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.payload)).toBe(VECTOR.signature);
    const headers = signWebhookHeaders(VECTOR.secret, VECTOR.payload, { id: VECTOR.id, timestampSeconds: VECTOR.timestamp });
    expect(headers).toEqual({ "content-type": "application/json", "webhook-id": VECTOR.id, "webhook-timestamp": "1614265330", "webhook-signature": VECTOR.signature });
  });

  it("a raw (non whsec_) secret is used as UTF-8 bytes; the whsec_ form is base64-decoded", () => {
    expect(standardWebhookSignature("plain-secret", VECTOR.id, VECTOR.timestamp, VECTOR.payload)).toBe("v1,3Iu+JbC8cHey9rJURLZfxQoX30vMfLebm9Kn1ePn6f4=");
    expect(decodeWebhookSecret(VECTOR.secret).length).toBe(24);
  });

  it("any change to id, timestamp or payload changes the signature", () => {
    const base = standardWebhookSignature(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.payload);
    expect(standardWebhookSignature(VECTOR.secret, "msg_other", VECTOR.timestamp, VECTOR.payload)).not.toBe(base);
    expect(standardWebhookSignature(VECTOR.secret, VECTOR.id, VECTOR.timestamp + 1, VECTOR.payload)).not.toBe(base);
    expect(standardWebhookSignature(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.payload + " ")).not.toBe(base);
  });
});

function harness(opts: { responses?: Array<number | Error>; debounceMs?: number; breakerThreshold?: number; breakerOpenMs?: number } = {}) {
  let now = 1_000_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const calls: Array<{ headers: Record<string, string>; body: string }> = [];
  const responses = opts.responses ?? [202];
  let n = 0;
  const notifier = new WakeNotifier({
    url: "https://hooks.example/wake",
    secret: VECTOR.secret,
    agentName: "Grok",
    debounceMs: opts.debounceMs ?? 30_000,
    now: () => now,
    sleep: async () => {},
    setTimer: (fn, ms) => timers.push({ at: now + ms, fn }),
    fetchImpl: (async (_url: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
      const r = responses[Math.min(n++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return new Response("", { status: r });
    }) as unknown as typeof fetch,
    breakerThreshold: opts.breakerThreshold ?? 5,
    breakerOpenMs: opts.breakerOpenMs ?? 300_000,
    maxAttempts: 3,
    backoffMs: [1, 1, 1]
  });
  const advance = async (ms: number) => {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    timers.splice(0, timers.length, ...timers.filter((t) => t.at > now));
    for (const t of due) t.fn();
    await notifier.settle();
  };
  return { notifier, calls, timers, advance, nowRef: () => now };
}

describe("WakeNotifier", () => {
  it("posts a signed ekho.message payload with a bounded preview", async () => {
    const h = harness();
    h.notifier.notify([msg("1", "x".repeat(300)), msg("2"), msg("3"), msg("4"), msg("5"), msg("6")]);
    await h.advance(0);
    expect(h.calls).toHaveLength(1);
    const body = JSON.parse(h.calls[0].body);
    expect(body).toMatchObject({ type: "ekho.message", agent: "Grok", count: 6 });
    expect(body.preview).toHaveLength(5);
    expect(body.preview[0].from).toBe("Jarvis");
    expect(body.preview[0].snippet.length).toBeLessThanOrEqual(140);
    const hd = h.calls[0].headers;
    expect(hd["webhook-signature"]).toBe(standardWebhookSignature(VECTOR.secret, hd["webhook-id"], Number(hd["webhook-timestamp"]), h.calls[0].body));
  });

  it("debounces: a burst within 30 s becomes one POST, the next one waits for the window", async () => {
    const h = harness();
    h.notifier.notify([msg("1")]);
    await h.advance(0); // first wake is immediate
    h.notifier.notify([msg("2")]);
    h.notifier.notify([msg("3")]);
    await h.advance(10_000);
    expect(h.calls).toHaveLength(1);
    await h.advance(20_000); // 30 s after the first POST
    expect(h.calls).toHaveLength(2);
    expect(JSON.parse(h.calls[1].body).count).toBe(2);
  });

  it("retries with backoff and then opens the breaker after repeated failures", async () => {
    const h = harness({ responses: [500], breakerThreshold: 2, breakerOpenMs: 60_000 });
    h.notifier.notify([msg("1")]);
    await h.advance(0);
    expect(h.calls).toHaveLength(3); // 3 attempts
    expect(h.notifier.stats.failed).toBe(1);
    expect(h.notifier.breakerOpen()).toBe(false);
    h.notifier.notify([msg("2")]);
    await h.advance(30_000);
    expect(h.calls).toHaveLength(6);
    expect(h.notifier.breakerOpen()).toBe(true);
    // While open: dropped, no network.
    h.notifier.notify([msg("3")]);
    await h.advance(30_000);
    expect(h.calls).toHaveLength(6);
    expect(h.notifier.stats.dropped_breaker_open).toBe(1);
    // After the cooling period, attempts resume.
    h.notifier.notify([msg("4")]);
    await h.advance(60_000);
    expect(h.calls).toHaveLength(9);
  });

  it("a network error counts as a failed attempt; a later 202 resets the failure streak", async () => {
    const h = harness({ responses: [new Error("ECONNREFUSED"), 202] });
    h.notifier.notify([msg("1")]);
    await h.advance(0);
    expect(h.calls).toHaveLength(2);
    expect(h.notifier.stats.sent).toBe(1);
    expect(h.notifier.stats.failed).toBe(0);
  });
});
