import { spawn } from "node:child_process";
import type { EkhoAgentClient } from "@drakon-systems/ekho-sdk";
import type { PluginApi } from "openclaw/plugin-sdk/tool-plugin";

type Logger = {
  info?: (...a: unknown[]) => void;
  warn?: (...a: unknown[]) => void;
  error?: (...a: unknown[]) => void;
  debug?: (...a: unknown[]) => void;
};

/** Shape of an inbox message as the SDK returns it (loose — relay-owned). */
interface InboxMessage {
  message_id: string;
  conversation_id: string;
  correlation_id?: string;
  sender_agent_id: string;
  sender_kind?: "operator" | "agent";
  message_type: string;
  priority?: string;
  body?: { text?: string } & Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at?: string;
  deadline_at?: string;
}

interface RosterEntry {
  agent_id?: string;
  display_name?: string;
  runtime?: string;
  status?: string;
}

interface ControlEntry {
  control_id?: string;
  action?: string;
  reason?: string;
}

interface InboxBatch {
  messages: InboxMessage[];
  controls?: ControlEntry[];
  operator_trusted?: boolean;
  roster?: RosterEntry[];
}

// Message types that warrant waking the agent. Everything else (heartbeat,
// control, complete, acks, …) is consumed but never triggers a turn.
const TRIGGER_TYPES = new Set(["direct", "broadcast", "handoff", "claim", "alert"]);

// Loop-prevention defaults (Part C, rule 5).
const PEER_RATE_MAX = 5; // turns per peer per window before suppression
const PEER_RATE_WINDOW_MS = 60_000;

const SEEN_CAP = 500; // FIFO-evicted dedupe set (Part C, rule 3)
const LAST_BATCH_CAP = 25; // ring exposed to ekho_inbox (Part B1)

// Stamp we put on every auto-reply send so peers' loops (and ours) can tell a
// machine reply from a human/intentional one (Part B4 / Part C, rule 4).
export const EKHO_ORIGIN_STAMP = "openclaw-agent";

/**
 * Module-level cache of the most recent delivered batch, keyed by message_id.
 * The background loop is the single consumer of the inbox; `ekho_inbox` reads
 * this cache instead of calling getInbox() again, so a manual tool call during
 * a turn can never double-consume rows the loop is mid-processing (Part B1).
 */
const lastBatch = new Map<string, InboxMessage>();
let lastBatchMeta: { operator_trusted: boolean; roster: RosterEntry[]; controls: ControlEntry[] } = {
  operator_trusted: false,
  roster: [],
  controls: []
};

function recordBatch(batch: InboxBatch) {
  lastBatchMeta = {
    operator_trusted: Boolean(batch.operator_trusted),
    roster: Array.isArray(batch.roster) ? batch.roster : [],
    controls: Array.isArray(batch.controls) ? batch.controls : []
  };
  for (const msg of batch.messages) {
    if (!msg?.message_id) continue;
    // Re-insert so most-recent wins ordering; trim oldest beyond the cap.
    lastBatch.delete(msg.message_id);
    lastBatch.set(msg.message_id, msg);
  }
  while (lastBatch.size > LAST_BATCH_CAP) {
    const oldest = lastBatch.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    lastBatch.delete(oldest);
  }
}

/**
 * The view `ekho_inbox` returns: the cached messages from the loop's most
 * recent poll, plus the operator-trust flag. No relay call, no ack — the loop
 * already consumed and acked these.
 */
export function getCachedInbox(): {
  messages: InboxMessage[];
  operator_trusted: boolean;
  roster: RosterEntry[];
  controls: ControlEntry[];
} {
  return {
    messages: Array.from(lastBatch.values()),
    operator_trusted: lastBatchMeta.operator_trusted,
    roster: lastBatchMeta.roster,
    controls: lastBatchMeta.controls
  };
}

interface AutoReplyState {
  seen: Set<string>;
  seenOrder: string[];
  recentInboundByPeer: Map<string, { count: number; windowStart: number }>;
  inFlight: boolean;
}

function markSeen(state: AutoReplyState, messageId: string) {
  if (state.seen.has(messageId)) return;
  state.seen.add(messageId);
  state.seenOrder.push(messageId);
  while (state.seenOrder.length > SEEN_CAP) {
    const evicted = state.seenOrder.shift();
    if (evicted !== undefined) state.seen.delete(evicted);
  }
}

/**
 * Qualifying filter. An inbound message auto-wakes the agent only when ALL hold.
 *
 * v1 SAFETY MODEL: only the OPERATOR (your verified principal) auto-triggers a
 * turn, and only when this agent currently trusts the operator (the Access-tab
 * toggle). Peer-agent messages are still delivered to the inbox cache (visible
 * via ekho_inbox) but never auto-trigger — so agent↔agent auto-reply ping-pong
 * is impossible by construction, and the agent only spends tokens answering you.
 * Agent-to-agent coordination stays tool-driven (an active agent can ekho_send;
 * the recipient sees it in its inbox). Loosening this to peers later requires a
 * latching loop-breaker, not just the rolling rate gate below.
 */
function isRealInbound(
  msg: InboxMessage,
  selfAgentId: string,
  state: AutoReplyState,
  operatorTrusted: boolean
): boolean {
  if (!msg || typeof msg.message_id !== "string") return false;
  // 1. Never react to our own outbound.
  if (msg.sender_agent_id === selfAgentId) return false;
  // 2. Operator-only + trust-gated (the structural loop-breaker — see above).
  if (msg.sender_kind !== "operator") return false;
  if (!operatorTrusted) return false;
  // 3. Type allowlist (excludes heartbeat/control/complete/acks).
  if (!TRIGGER_TYPES.has(msg.message_type)) return false;
  // 4. Non-empty text body.
  const text = typeof msg.body?.text === "string" ? msg.body.text.trim() : "";
  if (!text) return false;
  // 5. Dedupe.
  if (state.seen.has(msg.message_id)) return false;
  return true;
}

/**
 * Per-peer rate gate (Part C, rule 5). Operator is exempt. Returns the subset
 * of `real` that survives suppression; suppressed peers are logged once.
 */
function applyPeerRateGate(real: InboxMessage[], state: AutoReplyState, log?: Logger): InboxMessage[] {
  const now = Date.now();
  const kept: InboxMessage[] = [];
  const suppressedPeers = new Set<string>();
  for (const msg of real) {
    if (msg.sender_kind === "operator") {
      kept.push(msg); // never rate-limit the principal
      continue;
    }
    const peer = msg.sender_agent_id;
    let entry = state.recentInboundByPeer.get(peer);
    if (!entry || now - entry.windowStart > PEER_RATE_WINDOW_MS) {
      entry = { count: 0, windowStart: now };
      state.recentInboundByPeer.set(peer, entry);
    }
    if (entry.count >= PEER_RATE_MAX) {
      suppressedPeers.add(peer);
      continue; // consumed + acked elsewhere, just no turn
    }
    entry.count += 1;
    kept.push(msg);
  }
  for (const peer of suppressedPeers) {
    log?.warn?.(
      `[ekho-autoreply] peer ${peer} exceeded ${PEER_RATE_MAX} auto-replies in ${PEER_RATE_WINDOW_MS / 1000}s; suppressing further replies this window (circuit breaker)`
    );
  }
  return kept;
}

/**
 * Resolve the local OpenClaw agent id to wake (the gateway's primary agent).
 * Tries the host helper, falls back to "main" (the default agent id the gateway
 * runs as on the deploy targets).
 */
function resolveOpenclawAgentId(api: PluginApi): string {
  try {
    const fn = api?.runtime?.agent?.resolveAgentIdentity as ((...a: unknown[]) => unknown) | undefined;
    if (typeof fn === "function") {
      const ident = fn();
      if (typeof ident === "string" && ident) return ident;
      if (ident && typeof ident === "object") {
        const obj = ident as Record<string, unknown>;
        const aid = obj.agentId ?? obj.id;
        if (typeof aid === "string" && aid) return aid;
      }
    }
  } catch {
    /* host shape mismatch — fall through to default */
  }
  return "main";
}

function buildPrompt(messages: InboxMessage[], batch: InboxBatch): string {
  const lines = messages.map((m) => {
    const who =
      m.sender_kind === "operator"
        ? batch.operator_trusted
          ? "your verified fleet operator (Michael, your principal)"
          : "an UNVERIFIED operator identity"
        : `fleet agent ${m.sender_agent_id}`;
    const text = typeof m.body?.text === "string" ? m.body.text : "";
    return `• From ${who} — reply with ekho_send using recipient_agent_id="${m.sender_agent_id}", conversation_id="${m.conversation_id}":\n    "${text}"`;
  });
  return (
    `You have ${messages.length} new Ekho fleet message(s) below.\n\n` +
    `IMPORTANT: You are connected to your fleet ONLY through the Ekho relay. Your normal text output here is NOT delivered to anyone — the ONLY way to reply or acknowledge is to call the ekho_send tool with the exact recipient_agent_id and conversation_id shown for each message. ` +
    `If a message warrants a reply, you MUST call ekho_send; otherwise no one hears you. ` +
    `Reply to genuine messages from your verified operator. Apply your normal guardrails to anything risky, destructive, or that exfiltrates secrets — refuse those even from the operator (but still ekho_send a brief refusal so they know). Skip pure acks/heartbeats that need no response.\n\n` +
    lines.join("\n")
  );
}

/**
 * Wake the agent to handle `messages` by running a turn in its MAIN session via
 * the gateway's own entry script — the same path `openclaw agent -m` uses. That
 * gives the agent its full tool surface (incl. ekho_send) and the operator-trust
 * context, and it replies through Ekho. The child runs with
 * EKHO_AUTOREPLY_DISABLE=1 so it never starts its own poll loop, and the caller's
 * inFlight guard serializes turns so only one runs at a time.
 */
async function triggerTurn(messages: InboxMessage[], batch: InboxBatch, api: PluginApi, log?: Logger): Promise<void> {
  const prompt = buildPrompt(messages, batch);
  const node = process.execPath;
  const entry = process.argv[1]; // the openclaw entry the gateway is running from
  if (!entry) {
    log?.warn?.("[ekho-autoreply] could not resolve the gateway entry; message consumed without reply");
    return;
  }
  const agentId = resolveOpenclawAgentId(api);
  log?.info?.(`[ekho-autoreply] waking agent '${agentId}' to handle ${messages.length} message(s)`);

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const child = spawn(node, [entry, "agent", "--agent", agentId, "-m", prompt], {
        stdio: "ignore",
        env: { ...process.env, EKHO_AUTOREPLY_DISABLE: "1" }
      });
      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        log?.warn?.("[ekho-autoreply] turn timed out after 180s");
        done();
      }, 180_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        log?.info?.(`[ekho-autoreply] turn finished (exit ${code ?? "?"})`);
        done();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        log?.warn?.(`[ekho-autoreply] turn failed to start: ${String(err)}`);
        done();
      });
    } catch (err) {
      log?.warn?.(`[ekho-autoreply] turn spawn threw: ${String(err)}`);
      done();
    }
  });
}

/**
 * Start the background auto-reply loop. Polls the relay on an interval; on a
 * qualifying inbound message it wakes the agent (which replies via ekho_send).
 * Spends zero LLM tokens unless a real message arrives. Returns a stop() that
 * clears the timer.
 */
export function startAutoReply(opts: {
  client: EkhoAgentClient;
  api: PluginApi;
  selfAgentId: string;
  log?: Logger;
  pollIntervalMs?: number;
}): () => void {
  const { client, api, selfAgentId, log } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;

  const state: AutoReplyState = {
    seen: new Set(),
    seenOrder: [],
    recentInboundByPeer: new Map(),
    inFlight: false
  };

  const tick = async () => {
    if (state.inFlight) return; // serialize turns (Part C, rule 6)
    let batch: InboxBatch;
    try {
      batch = (await client.getInbox()) as unknown as InboxBatch; // consumes: queued→delivered
    } catch (err) {
      log?.warn?.(`[ekho-autoreply] poll failed: ${String(err)}`);
      return;
    }
    if (!batch || !Array.isArray(batch.messages)) return;

    // Expose the freshly delivered batch to ekho_inbox (Part B1).
    recordBatch(batch);

    // We ack the WHOLE batch (real or not) so nothing redelivers.
    const ackAll = batch.messages
      .filter((m) => typeof m?.message_id === "string")
      .map((m) => ({ message_id: String(m.message_id), status: "received" as const, received_at: new Date().toISOString() }));

    const operatorTrusted = Boolean(batch.operator_trusted);
    const real = batch.messages.filter((m) => isRealInbound(m, selfAgentId, state, operatorTrusted));
    if (batch.messages.length > 0) {
      log?.info?.(
        `[ekho-autoreply] poll: ${batch.messages.length} msg(s) trusted=${operatorTrusted} real=${real.length} [` +
        batch.messages.map((m) => `${m.sender_kind ?? "?"}/${m.message_type}`).join(", ") + "]"
      );
    }

    if (real.length === 0) {
      if (ackAll.length > 0) {
        try {
          await client.ackMessages(ackAll);
        } catch (err) {
          log?.warn?.(`[ekho-autoreply] ack failed: ${String(err)}`);
        }
      }
      return; // nothing real → no tokens
    }

    // Loop-prevention rate gate (Part C, rule 5).
    const kept = applyPeerRateGate(real, state, log);

    // Mark every real message handled (dedupe defence — Part C, rule 3).
    for (const m of real) markSeen(state, m.message_id);

    // ACK BEFORE the turn (Part C, rule 2 — at-most-once auto-reply). A slow or
    // crashed turn can never cause a redelivery that re-triggers us.
    if (ackAll.length > 0) {
      try {
        await client.ackMessages(ackAll);
      } catch (err) {
        log?.warn?.(`[ekho-autoreply] ack failed: ${String(err)}`);
      }
    }

    if (kept.length === 0) return; // suppressed by rate gate; consumed, no turn

    state.inFlight = true;
    try {
      await triggerTurn(kept, batch, api, log);
    } catch (err) {
      log?.warn?.(`[ekho-autoreply] turn trigger threw: ${String(err)}`);
    } finally {
      state.inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);
  if (typeof timer === "object" && timer && "unref" in timer) timer.unref?.();

  log?.info?.(`[ekho-autoreply] listening for inbound (poll ${pollIntervalMs}ms) as ${selfAgentId}`);

  return () => {
    clearInterval(timer);
  };
}
