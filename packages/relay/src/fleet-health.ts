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
