/**
 * Fleet-health verdict — the single source of truth for "is this agent
 * actually OK?" rendered on the operator health board and mined by the
 * attention ("Needs You") queue.
 *
 * The hard lesson this encodes: a heartbeat only proves the CONNECTION is up.
 * An agent whose model is failing every turn (bad auth, 404, quota) keeps
 * heartbeating "healthy" while its brain is dead. So the verdict combines TWO
 * independent axes and takes the worse of them:
 *   1. Connection liveness — status + heartbeat freshness.
 *   2. Cognitive health   — the plugin's turn_health signal (model_call_ended
 *      outcomes), absent on older plugins (treated as unknown, never green-washed).
 *
 * Pure and time-injected so every threshold is unit-tested directly.
 */

export type HealthLevel = "ok" | "degraded" | "down";

export interface AgentHealthInput {
  status?: string | null;
  last_heartbeat_at?: string | null;
  consecutive_missed_heartbeats?: number | null;
  /** Parsed heartbeat metrics (may carry turn_health/model_errors_1h/last_error). */
  metrics?: Record<string, unknown> | null;
}

export interface AgentHealthVerdict {
  level: HealthLevel;
  reason: string;
  /** True when we have no cognitive signal at all (old plugin / no turns yet). */
  cognitive_unknown: boolean;
}

// A heartbeat older than this means the connection is effectively dead. The
// plugin beats every ~30s; 3 minutes tolerates a couple of misses + jitter.
export const HEARTBEAT_STALE_MS = 3 * 60_000;

function ageMs(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? now - t : null;
}

function humanAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export function deriveAgentHealth(input: AgentHealthInput, now: number = Date.now()): AgentHealthVerdict {
  const status = (input.status ?? "").toLowerCase();
  const metrics = input.metrics ?? {};
  const turnHealth = typeof metrics.turn_health === "string" ? String(metrics.turn_health) : "";
  const lastError = typeof metrics.last_error === "string" ? String(metrics.last_error) : "";
  const errors1h = Number(metrics.model_errors_1h ?? 0) || 0;
  const cognitive_unknown = turnHealth === "" || turnHealth === "unknown";

  // 1. Hard lifecycle states dominate everything.
  if (status === "revoked") return { level: "down", reason: "revoked", cognitive_unknown };
  if (status === "quarantined") return { level: "down", reason: "quarantined", cognitive_unknown };

  // 2. Connection liveness.
  const hbAge = ageMs(input.last_heartbeat_at, now);
  if (hbAge === null) return { level: "down", reason: "no heartbeat received", cognitive_unknown };
  if (hbAge > HEARTBEAT_STALE_MS) {
    return { level: "down", reason: `no heartbeat for ${humanAge(hbAge)}`, cognitive_unknown };
  }

  // 3. Cognitive health (only reachable when the connection is live).
  if (turnHealth === "down") {
    return { level: "down", reason: lastError ? `model failing every turn (${lastError})` : "model failing every turn", cognitive_unknown: false };
  }
  if (status === "paused") return { level: "degraded", reason: "paused", cognitive_unknown };
  if (turnHealth === "degraded") {
    return { level: "degraded", reason: lastError ? `model errors (${errors1h}/1h, last: ${lastError})` : `model errors (${errors1h}/1h)`, cognitive_unknown: false };
  }

  return { level: "ok", reason: cognitive_unknown ? "connected (no turn data yet)" : "healthy", cognitive_unknown };
}

// ---- "Needs You" queue ----------------------------------------------------
// Agents can't DM the operator, so failures otherwise only surface as raw
// events in the firehose. This folds the three things that actually need a
// human — dead/degraded models, stalled hand-offs, and dropped deliveries —
// into one ranked to-do list. Pure so the ranking/shape is unit-tested.

// ---------------------------------------------------------------------------
// #155 Phase 2: per-agent INBOX state, a second axis next to `health`.
//
// `health` proves the connection (heartbeats) and the model (turn outcomes).
// It cannot see an inbox that heartbeats but never fetches. This derives one
// state from relay-observed delivery data. Heartbeat freshness is deliberately
// NOT an input, so a heartbeating agent that never polls still reads
// unresponsive_inbox.
//
// Limit: no adapter reports adapter_state / turn_started_at / turn_deadline_at
// yet (Phase 3). Until then an agent inside a long turn with work queued behind
// it can read unresponsive_inbox, and `working` / `floor_wait` cannot occur on
// live data. Once an adapter reports turn_running, a missing or unparseable
// turn_deadline_at is bounded by turn_started_at + the turn cap (or, with no
// start either, by the age of the oldest queued delivery); see deriveInboxState.
// ---------------------------------------------------------------------------

export type InboxState = "unresponsive_inbox" | "working" | "floor_wait" | "queued" | "idle";

export interface InboxStateInput {
  /** Deliveries with status 'queued' (not yet fetched). */
  queued: number;
  oldest_queued_at?: string | null;
  /** Relay time of the agent's last GET /v1/inbox; null = never polled. */
  last_poll_at?: string | null;
  /**
   * Deliveries waiting on a floor: wait started, never granted/overrun, no turn
   * attempt. Counts rows in status `queued` AND `delivered` (see the SQL in
   * getFleetHealth); a floor wait is reported by the adapter and can start
   * before or after the delivery is fetched.
   */
  floor_waits?: number;
  /**
   * Longest a turn may run, in seconds (the clamped EKHO_TURN_INTERVAL_CAP_SECONDS).
   * Bounds a `turn_running` report that carries no usable deadline. Default 900.
   */
  turn_cap_seconds?: number;
  /** Detection threshold in seconds (the existing clamped inboxStaleSeconds). */
  stale_seconds: number;
  /** Parsed heartbeat metrics; adapter_state / turn_* read only when strings. */
  metrics?: Record<string, unknown> | null;
}

// Grace after a reported turn deadline before the turn counts as wedged.
export const TURN_DEADLINE_GRACE_MS = 60_000;
// Default turn cap, matching the adapters' TURN_TIMEOUT and the relay's
// EKHO_TURN_INTERVAL_CAP_SECONDS default.
export const DEFAULT_TURN_CAP_SECONDS = 900;

function strMetric(m: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = m?.[key];
  return typeof v === "string" && v !== "" ? v : null;
}

export function deriveInboxState(input: InboxStateInput, now: number = Date.now()): InboxState {
  const staleMs = Math.max(0, Number(input.stale_seconds) || 0) * 1000;
  const queued = Math.max(0, Number(input.queued) || 0);
  const adapterState = strMetric(input.metrics, "adapter_state");
  const turnRunning = adapterState === "turn_running";
  const oldestAge = ageMs(input.oldest_queued_at, now);
  const capMs = (Number.isFinite(Number(input.turn_cap_seconds)) && Number(input.turn_cap_seconds) > 0
    ? Number(input.turn_cap_seconds) : DEFAULT_TURN_CAP_SECONDS) * 1000;

  // A reported turn is wedged once it is past its deadline plus grace. A
  // `turn_running` report with no parseable deadline must not mask an
  // unresponsive inbox forever (#186), so it is bounded instead: by the reported
  // start plus the cap, or, with no usable start either, by the age of the
  // oldest queued delivery (an adapter does not poll during a turn, and no turn
  // may run longer than the cap, so work queued longer than cap + grace has
  // outlived any turn that could be holding it).
  let wedged = false;
  if (turnRunning) {
    const deadlineMs = Date.parse(strMetric(input.metrics, "turn_deadline_at") ?? "");
    const startedMs = Date.parse(strMetric(input.metrics, "turn_started_at") ?? "");
    if (Number.isFinite(deadlineMs)) wedged = now > deadlineMs + TURN_DEADLINE_GRACE_MS;
    else if (Number.isFinite(startedMs)) wedged = now > startedMs + capMs + TURN_DEADLINE_GRACE_MS;
    else wedged = oldestAge !== null && oldestAge > capMs + TURN_DEADLINE_GRACE_MS;
  }

  const pollAge = ageMs(input.last_poll_at, now);
  const pollStale = pollAge === null || pollAge > staleMs;

  // 1. Queued work, old, and nothing is fetching it.
  if (queued > 0 && oldestAge !== null && oldestAge > staleMs && ((pollStale && !turnRunning) || wedged)) {
    return "unresponsive_inbox";
  }
  // 2. A reported running turn: the busy wait, named.
  if (turnRunning) return "working";
  // 3. Waiting on a conversation floor.
  if ((input.floor_waits ?? 0) > 0) return "floor_wait";
  // 4. Queued, within the threshold.
  if (queued > 0) return "queued";
  return "idle";
}

export type AttentionSeverity = "critical" | "warn";
export type AttentionKind = "agent_down" | "agent_degraded" | "stalled" | "dead_letter";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  agentId?: string;
  conversationId?: string;
  at: string | null;
}

export interface AttentionSources {
  agents: Array<{ id: string; display_name?: string | null; health?: AgentHealthVerdict; last_heartbeat_at?: string | null }>;
  stalled: Array<{ id: string; actor_id?: string | null; conversation_id?: string | null; created_at?: string | null; payload?: Record<string, unknown> | null }>;
  deadLetters: Array<{ id: string; recipient_agent_id?: string | null; sender_agent_id?: string | null; conversation_id?: string | null; failure_reason?: string | null; dead_lettered_at?: string | null }>;
  agentNames?: Record<string, string>;
}

const SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, warn: 1 };

export function buildAttentionItems(src: AttentionSources): AttentionItem[] {
  const name = (id?: string | null) => (id ? src.agentNames?.[id] || id : "unknown");
  const items: AttentionItem[] = [];

  for (const a of src.agents) {
    const level = a.health?.level;
    if (level === "down") {
      items.push({ id: `agent:${a.id}`, kind: "agent_down", severity: "critical", title: `${a.display_name || a.id} is down`, detail: a.health?.reason || "unhealthy", agentId: a.id, at: a.last_heartbeat_at ?? null });
    } else if (level === "degraded") {
      items.push({ id: `agent:${a.id}`, kind: "agent_degraded", severity: "warn", title: `${a.display_name || a.id} is degraded`, detail: a.health?.reason || "degraded", agentId: a.id, at: a.last_heartbeat_at ?? null });
    }
  }

  for (const s of src.stalled) {
    const reason = typeof s.payload?.reason === "string" ? String(s.payload.reason) : "conversation paused with work pending";
    items.push({ id: `stall:${s.id}`, kind: "stalled", severity: "warn", title: `${name(s.actor_id)} stalled a conversation`, detail: reason, agentId: s.actor_id ?? undefined, conversationId: s.conversation_id ?? undefined, at: s.created_at ?? null });
  }

  for (const d of src.deadLetters) {
    items.push({ id: `dead:${d.id}`, kind: "dead_letter", severity: "critical", title: `Undelivered message to ${name(d.recipient_agent_id)}`, detail: `from ${name(d.sender_agent_id)} — ${d.failure_reason || "delivery failed"}`, agentId: d.recipient_agent_id ?? undefined, conversationId: d.conversation_id ?? undefined, at: d.dead_lettered_at ?? null });
  }

  // Critical first, then most-recent first (nulls last).
  return items.sort((x, y) => {
    const s = SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity];
    if (s !== 0) return s;
    const tx = x.at ? Date.parse(x.at) : -Infinity;
    const ty = y.at ? Date.parse(y.at) : -Infinity;
    return ty - tx;
  });
}
