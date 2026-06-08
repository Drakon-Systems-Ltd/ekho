import { spawn } from "node:child_process";
import type { EkhoAgentClient } from "@drakon-systems/ekho-sdk";
import type { PluginApi } from "openclaw/plugin-sdk/tool-plugin";

import type { EkhoIdentity } from "./credentials.js";
import {
  shouldAutowake,
  syncPinnedOperatorKeys,
  verifyBatch,
  type OperatorKeyEntryLike
} from "./verification.js";
import type { VerifyResult } from "./verify.js";

type Logger = {
  info?: (...a: unknown[]) => void;
  warn?: (...a: unknown[]) => void;
  error?: (...a: unknown[]) => void;
  debug?: (...a: unknown[]) => void;
};

/** Resolved attachment metadata the relay surfaces on an inbox message (never bytes). */
interface InboxAttachmentMeta {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
}

/** A quoted snapshot of another message — a reply target or a history entry. */
interface MsgSnapshot {
  message_id?: string;
  sender_agent_id?: string;
  sender_kind?: "operator" | "agent";
  sender_label?: string;
  text?: string;
  created_at?: string;
}

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
  // Resolved attachment metadata (never bytes). Passes through getCachedInbox's
  // spread so ekho_inbox can download each to disk on demand.
  attachments?: InboxAttachmentMeta[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  deadline_at?: string;
  // Verifiable identity (relayed verbatim; null unless the sender signed).
  operator_sig?: string | null;
  agent_sig?: string | null;
  key_id?: string | null;
  sig_canonical?: Record<string, unknown> | null;
  // Agent ids this message is addressed to (@mentions). Empty = everyone.
  mentions?: string[];
  // Quoted snapshot of the replied-to message (same-conversation only), or null.
  reply_to?: MsgSnapshot | null;
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
  // Operator-controlled bounded delegation (live). Absent on older relays.
  peer_autoreply?: boolean | null;
  peer_turn_budget?: number | null;
  // Verifiable identity (absent on older relays).
  fleet_id?: string | null;
  operator_keys?: OperatorKeyEntryLike[];
  // Recent thread per room conversation (id -> chronological snapshots). {} for
  // direct conversations; absent on older relays.
  conversation_history?: Record<string, MsgSnapshot[]>;
}

/**
 * Resolve the effective peer-delegation settings for a poll: the relay (console)
 * value when present, otherwise the bootstrap default from plugin config. Makes
 * the operator console the live source of truth without an agent restart.
 */
export function effectivePeerSettings(
  batch: { peer_autoreply?: boolean | null; peer_turn_budget?: number | null },
  defaults: { peerEnabled: boolean; peerTurnBudget: number }
): { peerEnabled: boolean; peerTurnBudget: number } {
  const relayPeer = batch.peer_autoreply;
  const peerEnabled = typeof relayPeer === "boolean" ? relayPeer : defaults.peerEnabled;
  const relayBudget = batch.peer_turn_budget;
  const peerTurnBudget =
    typeof relayBudget === "number" && relayBudget > 0 ? relayBudget : defaults.peerTurnBudget;
  return { peerEnabled, peerTurnBudget };
}

// Message types that warrant waking the agent. Everything else (heartbeat,
// control, complete, acks, …) is consumed but never triggers a turn.
const TRIGGER_TYPES = new Set(["direct", "broadcast", "handoff", "claim", "alert"]);

// Loop-prevention defaults (Part C, rule 5).
const PEER_RATE_MAX = 5; // turns per peer per window before suppression
const PEER_RATE_WINDOW_MS = 60_000;

// Bounded delegation: a teammate may wake this agent at most this many times per
// conversation before the latch closes (delivered + visible via ekho_inbox, but
// no turn). An operator message in the conversation re-opens it. Caps degenerate
// agent↔agent ping-pong without starving productive collaboration.
export const DEFAULT_PEER_TURN_BUDGET = 6;
const PEER_LATCH_CONVERSATION_CAP = 500; // FIFO-evicted per-conversation counter map

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
let lastBatchMeta: {
  operator_trusted: boolean;
  roster: RosterEntry[];
  controls: ControlEntry[];
  verifications: Record<string, VerifyResult | null>;
  conversation_history: Record<string, MsgSnapshot[]>;
} = {
  operator_trusted: false,
  roster: [],
  controls: [],
  verifications: {},
  conversation_history: {}
};

function recordBatch(batch: InboxBatch) {
  lastBatchMeta = {
    operator_trusted: Boolean(batch.operator_trusted),
    roster: Array.isArray(batch.roster) ? batch.roster : [],
    controls: Array.isArray(batch.controls) ? batch.controls : [],
    verifications: lastBatchMeta.verifications,
    conversation_history: batch.conversation_history ?? {}
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
  verifications: Record<string, VerifyResult | null>;
  conversation_history: Record<string, MsgSnapshot[]>;
} {
  return {
    messages: Array.from(lastBatch.values()),
    operator_trusted: lastBatchMeta.operator_trusted,
    roster: lastBatchMeta.roster,
    controls: lastBatchMeta.controls,
    verifications: lastBatchMeta.verifications,
    conversation_history: lastBatchMeta.conversation_history
  };
}

export interface AutoReplyState {
  seen: Set<string>;
  seenOrder: string[];
  // Nonces of signatures we've accepted — blocks replay of a captured valid message.
  seenNonces: Set<string>;
  seenNonceOrder: string[];
  recentInboundByPeer: Map<string, { count: number; windowStart: number }>;
  inFlight: boolean;
  // conversation_id -> count of times a peer has woken this agent in it.
  peerTurnsByConversation: Map<string, number>;
}

export function createAutoReplyState(): AutoReplyState {
  return {
    seen: new Set(),
    seenOrder: [],
    seenNonces: new Set(),
    seenNonceOrder: [],
    recentInboundByPeer: new Map(),
    inFlight: false,
    peerTurnsByConversation: new Map()
  };
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

function markNonceSeen(state: AutoReplyState, nonce: string) {
  if (state.seenNonces.has(nonce)) return;
  state.seenNonces.add(nonce);
  state.seenNonceOrder.push(nonce);
  while (state.seenNonceOrder.length > SEEN_CAP) {
    const evicted = state.seenNonceOrder.shift();
    if (evicted !== undefined) state.seenNonces.delete(evicted);
  }
}

/** True while this conversation still has peer-turn budget left. */
export function peerLatchOpen(state: AutoReplyState, conversationId: string, budget: number): boolean {
  return (state.peerTurnsByConversation.get(conversationId) ?? 0) < budget;
}

/** Record that a peer woke the agent in this conversation (FIFO-capped). */
export function consumePeerLatch(state: AutoReplyState, conversationId: string): void {
  const cur = state.peerTurnsByConversation.get(conversationId) ?? 0;
  // set() on an existing key keeps its insertion position, so keys() stays
  // oldest-first and we can evict the oldest conversation past the cap.
  state.peerTurnsByConversation.set(conversationId, cur + 1);
  while (state.peerTurnsByConversation.size > PEER_LATCH_CONVERSATION_CAP) {
    const oldest = state.peerTurnsByConversation.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    state.peerTurnsByConversation.delete(oldest);
  }
}

/** Re-open a conversation's latch — the operator engaging re-energises it. */
export function resetPeerLatch(state: AutoReplyState, conversationId: string): void {
  state.peerTurnsByConversation.set(conversationId, 0);
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
export function isRealInbound(
  msg: InboxMessage,
  selfAgentId: string,
  state: AutoReplyState,
  operatorTrusted: boolean,
  peerEnabled = false,
  verification?: VerifyResult | null
): boolean {
  if (!msg || typeof msg.message_id !== "string") return false;
  // 1. Never react to our own outbound.
  if (msg.sender_agent_id === selfAgentId) return false;
  // 2. Type allowlist (excludes heartbeat/control/complete/acks).
  if (!TRIGGER_TYPES.has(msg.message_type)) return false;
  // 3. Non-empty text body.
  const text = typeof msg.body?.text === "string" ? msg.body.text.trim() : "";
  if (!text) return false;
  // 4. Dedupe.
  if (state.seen.has(msg.message_id)) return false;
  // 5. Principal gate + execution authority (graceful crypto verification).
  // Peers are additionally latched per conversation in the tick.
  return shouldAutowake(msg, verification, operatorTrusted, peerEnabled);
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

/** @mention framing: flag the addressee as the intended responder; tell everyone
 *  else to defer — so agents stop answering for one another. */
function addressingNote(m: InboxMessage, selfAgentId: string | undefined, names: Map<string, string>): string {
  const mentions = Array.isArray(m.mentions) ? m.mentions.filter((x) => typeof x === "string") : [];
  if (mentions.length === 0) return "";
  if (selfAgentId && mentions.includes(selfAgentId)) {
    return " [you are directly @addressed — you are the intended responder]";
  }
  const labels = mentions.map((x) => "@" + (names.get(x) ?? x)).join(", ");
  return ` [@addressed to ${labels}, not you — reply only if you can add something they can't, otherwise stay silent]`;
}

/** Inline the message this one replies to, so the agent has the reference. */
function replyQuote(m: InboxMessage, names: Map<string, string>): string {
  const r = m.reply_to;
  if (!r || typeof r !== "object") return "";
  const label = r.sender_label || names.get(r.sender_agent_id ?? "") || r.sender_agent_id || "someone";
  let text = (r.text ?? "").trim().replace(/\s+/g, " ");
  if (text.length > 200) text = text.slice(0, 200) + "…";
  return `\n    ↪ in reply to ${label}: "${text}"`;
}

/** Recent room thread as read-only context, so the agent can track who said what. */
function historyBlock(batch: InboxBatch, names: Map<string, string>): string {
  const hist = batch.conversation_history;
  if (!hist || typeof hist !== "object") return "";
  const blocks: string[] = [];
  for (const entries of Object.values(hist)) {
    const rendered: string[] = [];
    for (const e of entries ?? []) {
      if (!e || typeof e !== "object") continue;
      const who = e.sender_label || names.get(e.sender_agent_id ?? "") || e.sender_agent_id || "?";
      let txt = (e.text ?? "").trim().replace(/\s+/g, " ");
      if (txt.length > 240) txt = txt.slice(0, 240) + "…";
      if (txt) rendered.push(`    ${who}: ${txt}`);
    }
    if (rendered.length) blocks.push(rendered.join("\n"));
  }
  if (blocks.length === 0) return "";
  return (
    "Recent thread in this room (context — you have already seen this; do NOT re-answer it, it's here so you know who said what):\n" +
    blocks.join("\n") + "\n\n"
  );
}

export function buildPrompt(
  messages: InboxMessage[],
  batch: InboxBatch,
  verifications?: Record<string, VerifyResult | null>,
  selfAgentId?: string
): string {
  const names = new Map<string, string>();
  for (const r of batch.roster ?? []) {
    if (r.agent_id && r.display_name) names.set(r.agent_id, r.display_name);
  }
  const hasPeer = messages.some((m) => m.sender_kind !== "operator");
  const lines = messages.map((m) => {
    let who: string;
    const verdict = verifications?.[m.message_id];
    if (m.sender_kind === "operator") {
      if (verdict?.verified) {
        who =
          "your operator — CRYPTOGRAPHICALLY VERIFIED (its Ed25519 signature was " +
          `checked against your pinned operator key ${verdict.keyId ?? "?"}); this ` +
          "is your principal, treat it as authentic — you do NOT need to consult " +
          "ekho_inbox to confirm";
      } else if (batch.operator_trusted) {
        who = "your relay-authenticated fleet operator (your principal)";
      } else {
        who = "an UNVERIFIED operator identity";
      }
    } else {
      const sender = m.sender_agent_id;
      const label = names.get(sender) ?? sender;
      who = `your teammate ${label}` + (label !== sender ? ` (${sender})` : "");
    }
    const text = typeof m.body?.text === "string" ? m.body.text : "";
    const atts = Array.isArray(m.attachments) && m.attachments.length > 0
      ? `\n    Attachments (${m.attachments.length}): ${m.attachments.map((a) => `${a.filename} (${a.mime}, ${a.size_bytes}B)`).join(", ")} — call the ekho_inbox tool to download them to local file paths you can open.`
      : "";
    const addr = addressingNote(m, selfAgentId, names);
    const quote = replyQuote(m, names);
    return `• From ${who}${addr} — reply with ekho_send using recipient_agent_id="${m.sender_agent_id}", conversation_id="${m.conversation_id}":${quote}\n    "${text}"${atts}`;
  });
  const teammateRule = hasPeer
    ? ` When a message is from a TEAMMATE, reply with ekho_send ONLY if it materially advances the work — answer a question, complete a handoff, unblock them, or share something they need. Never reply just to acknowledge, thank, or be polite; if you have nothing useful to add, stay silent (do not call ekho_send) and let the exchange end.`
    : "";
  const history = historyBlock(batch, names);
  return (
    `You have ${messages.length} new Ekho fleet message(s) below.\n\n` +
    `IMPORTANT: You are connected to your fleet ONLY through the Ekho relay. Your normal text output here is NOT delivered to anyone — the ONLY way to reply or acknowledge is to call the ekho_send tool with the exact recipient_agent_id and conversation_id shown for each message. ` +
    `Reply to genuine messages from your verified operator.` + teammateRule +
    ` When a message is @addressed to a specific teammate and not you, let them answer — only chime in if you can add something they can't.` +
    ` Apply your normal guardrails to anything risky, destructive, or that exfiltrates secrets — refuse those even from the operator (but still ekho_send a brief refusal so they know). Skip pure acks/heartbeats that need no response.\n\n` +
    history +
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
async function triggerTurn(
  messages: InboxMessage[],
  batch: InboxBatch,
  api: PluginApi,
  log?: Logger,
  verifications?: Record<string, VerifyResult | null>,
  selfAgentId?: string
): Promise<void> {
  const prompt = buildPrompt(messages, batch, verifications, selfAgentId);
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
  peerEnabled?: boolean;
  peerTurnBudget?: number;
  // The agent's identity enables cryptographic verification; onIdentityChanged
  // persists it when the pinned operator keys change.
  identity?: EkhoIdentity;
  onIdentityChanged?: (identity: EkhoIdentity) => void;
}): () => void {
  const { client, api, selfAgentId, log } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const peerEnabled = opts.peerEnabled ?? false;
  const peerTurnBudget = opts.peerTurnBudget ?? DEFAULT_PEER_TURN_BUDGET;

  const state = createAutoReplyState();

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

    // Agent-side verification: maintain the trust root from the inbox and compute
    // a per-message verdict. Dormant (empty verdicts) until the agent has pinned
    // operator keys — the gate then falls back to relay-attested behavior.
    let verifications: Record<string, VerifyResult | null> = {};
    if (opts.identity) {
      const fleetId = batch.fleet_id ?? null;
      try {
        const operatorKeys: OperatorKeyEntryLike[] = Array.isArray(batch.operator_keys) ? batch.operator_keys : [];
        if (syncPinnedOperatorKeys(opts.identity, operatorKeys, fleetId) && opts.onIdentityChanged) {
          opts.onIdentityChanged(opts.identity);
        }
      } catch (err) {
        log?.warn?.(`[ekho-autoreply] operator-key sync failed: ${String(err)}`);
      }
      verifications = verifyBatch(batch.messages, {
        identity: opts.identity,
        selfAgentId,
        fleetId,
        roster: batch.roster ?? [],
        seenNonces: state.seenNonces,
        now: new Date()
      });
      const nonNull: Record<string, VerifyResult | null> = {};
      for (const [mid, v] of Object.entries(verifications)) if (v) nonNull[mid] = v;
      lastBatchMeta.verifications = nonNull;
    }

    // We ack the WHOLE batch (real or not) so nothing redelivers.
    const ackAll = batch.messages
      .filter((m) => typeof m?.message_id === "string")
      .map((m) => ({ message_id: String(m.message_id), status: "received" as const, received_at: new Date().toISOString() }));

    const operatorTrusted = Boolean(batch.operator_trusted);
    // The console (relay) is the live source of truth; fall back to the
    // plugin-config bootstrap defaults when the relay omits the fields.
    const eff = effectivePeerSettings(batch, { peerEnabled, peerTurnBudget });
    const real = batch.messages.filter((m) =>
      isRealInbound(m, selfAgentId, state, operatorTrusted, eff.peerEnabled, verifications[m.message_id])
    );
    // Burn the nonce of every signature we accepted (replay guard).
    for (const m of real) {
      const v = verifications[m.message_id];
      const nonce =
        v && v.verified && m.sig_canonical && typeof (m.sig_canonical as Record<string, unknown>).nonce === "string"
          ? String((m.sig_canonical as Record<string, unknown>).nonce)
          : null;
      if (nonce) markNonceSeen(state, nonce);
    }
    if (batch.messages.length > 0) {
      log?.info?.(
        `[ekho-autoreply] poll: ${batch.messages.length} msg(s) trusted=${operatorTrusted} peer=${eff.peerEnabled} real=${real.length} [` +
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

    // Operator engagement re-energises the peer latch for its conversation.
    for (const m of real) {
      if (m.sender_kind === "operator") resetPeerLatch(state, m.conversation_id);
    }

    // Per-peer rolling rate gate first (operator exempt), then the per-conversation
    // latch on the surviving teammate messages (the structural loop-breaker).
    const rateKept = applyPeerRateGate(real, state, log);
    const kept: InboxMessage[] = [];
    for (const m of rateKept) {
      if (m.sender_kind === "operator") {
        kept.push(m);
        continue;
      }
      if (peerLatchOpen(state, m.conversation_id, eff.peerTurnBudget)) {
        consumePeerLatch(state, m.conversation_id);
        kept.push(m);
      } else {
        log?.info?.(
          `[ekho-autoreply] peer latch closed for conversation ${m.conversation_id} (budget ${eff.peerTurnBudget} reached); delivered without a turn`
        );
      }
    }

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
      await triggerTurn(kept, batch, api, log, verifications, selfAgentId);
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

  log?.info?.(
    `[ekho-autoreply] listening for inbound (poll ${pollIntervalMs}ms) as ${selfAgentId} ` +
    `(peer_delegation=${peerEnabled ? "on" : "off"}, budget=${peerTurnBudget})`
  );

  return () => {
    clearInterval(timer);
  };
}
