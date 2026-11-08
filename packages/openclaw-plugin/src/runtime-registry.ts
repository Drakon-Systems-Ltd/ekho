/**
 * One heartbeat/auto-reply producer per agent per process, across module copies.
 *
 * Every timer this plugin starts lives in module state (connection.ts). A host
 * hot reload (`openclaw plugins reload|update`) evaluates a FRESH copy of the
 * bundle from a new install generation in the same process, so the old copy's
 * timers keep running unless something stops them: each reload added another
 * heartbeat producer (with its own, stale turn-health window) and another
 * inbox poller. The host's stop signal (see index.ts) is the first line of
 * defence; this registry is the second, for hosts that never send one.
 *
 * It lives on globalThis under a registered symbol, so every copy of the
 * bundle in the process sees the same map. Each module copy takes a
 * generation number from it at load, so "newer" is a total order even when two
 * copies connect out of order: the newest generation always wins, and an older
 * one that finishes connecting late stands down instead of stopping the new one.
 */

export const RUNTIME_REGISTRY_KEY = Symbol.for("ekho-adapter.runtime");

export interface AgentRuntimeHolder {
  generation: number;
  /** Stops this holder's heartbeat, auto-reply loop and anything else it runs. */
  stop: (reason: string) => void | Promise<void>;
  /**
   * Produce again after the generation that superseded this one released the
   * agent with no successor (#160). Synchronous; true once this holder has
   * re-claimed the agent, false when it cannot (its host unloaded it, or it
   * no longer has a connection) — then it is dropped from standby for good.
   * `successorDrain` settles when the releasing generation's loop has drained
   * (its poll in flight included, within its bound); anything that must not
   * overlap that loop waits for it.
   */
  resume?: (successorDrain: Promise<void>) => boolean;
}

interface RuntimeRegistry {
  /** Last generation handed out; module copies take the next one at load. */
  generations: number;
  byAgent: Map<string, AgentRuntimeHolder>;
  /**
   * Per agent, the holders a newer generation superseded, oldest first. A
   * superseded holder is only ever stopped by the hand-off; its host may
   * still consider its registration live. When the holder of an agent is
   * released without a successor (the host disposed the newer registry, as a
   * slow-start second register pass does, #160) the most recent standby
   * resumes, so the agent never sits with zero heartbeating generations.
   * Added after the first registry shape: an older copy may not have it.
   */
  standby?: Map<string, AgentRuntimeHolder[]>;
  /** Tail of each enrolment key's lock queue (see runEnrolmentExclusive). */
  enrolments?: Map<string, Promise<void>>;
  /** Operator keys from an enrolment, for whichever copy bootstraps identity. */
  enrolOperatorKeys?: Map<string, unknown[]>;
}

function registry(): RuntimeRegistry {
  const g = globalThis as typeof globalThis & { [RUNTIME_REGISTRY_KEY]?: RuntimeRegistry };
  let r = g[RUNTIME_REGISTRY_KEY];
  // Defensive about the shape: a future version may store more, never less.
  if (!r || typeof r !== "object" || !(r.byAgent instanceof Map)) {
    r = { generations: 0, byAgent: new Map() };
    g[RUNTIME_REGISTRY_KEY] = r;
  }
  return r;
}

/** A fresh, process-wide generation number. Call once per module evaluation. */
export function nextRuntimeGeneration(): number {
  const r = registry();
  r.generations += 1;
  return r.generations;
}

/**
 * Become the one producer for `agentId`. A holder from an OLDER generation is
 * stopped first (its stop must not throw, but a throwing one never blocks the
 * hand-off). Returns false — and changes nothing — when a NEWER generation
 * already holds the agent: the caller is stale and must not start anything.
 * Also false if, by the time the old holder's stop has returned, the slot is
 * no longer this holder's (a re-entrant claim won it): then too the caller
 * must start nothing.
 */
export function claimAgentRuntime(agentId: string, holder: AgentRuntimeHolder): boolean {
  const r = registry();
  const current = r.byAgent.get(agentId);
  if (current && current.generation > holder.generation) return false;
  // Claim before stopping the old holder: its stop releases the agent, and a
  // release must see the successor in place, not an empty slot to refill from
  // standby (which would resume the very generation being stood down).
  r.byAgent.set(agentId, holder);
  const waiting = standbyFor(r, agentId);
  // A resuming (or re-registered) holder is a producer again, not a standby.
  dropStandby(waiting, holder.generation);
  if (current && current.generation !== holder.generation) {
    // The old holder is stopped by this hand-off alone; its host may still
    // hold its registration live. Keep it ready to resume (#160).
    if (current.resume) {
      dropStandby(waiting, current.generation);
      waiting.push(current);
    }
    try {
      current.stop(`superseded by generation ${holder.generation}`);
    } catch {
      /* the old copy is going away regardless */
    }
  }
  forgetIfEmpty(r, agentId, waiting);
  // The stop above may re-enter this registry (a stop that itself claims, or
  // a release that resumes a standby). Only a holder that still owns the slot
  // once everything synchronous has settled may start producing.
  return r.byAgent.get(agentId) === holder;
}

/**
 * Drop `agentId`'s entry if (and only if) this generation still holds it.
 * With the slot empty, the most recently superseded generation that can still
 * produce resumes (#160: a successor disposed before anything replaced it),
 * handed `drained`: the releasing generation's own drain promise.
 * A standby that declines (its host unloaded it too) is discarded, and the
 * next older one is tried. Nothing resumes when the slot stays held: a
 * superseded generation's own release is a no-op by then (see claim above).
 */
export function releaseAgentRuntime(
  agentId: string,
  generation: number,
  drained: Promise<void> = Promise.resolve()
): void {
  const r = registry();
  if (r.byAgent.get(agentId)?.generation !== generation) return;
  r.byAgent.delete(agentId);
  const waiting = standbyFor(r, agentId);
  while (waiting.length > 0 && !r.byAgent.has(agentId)) {
    const candidate = waiting.pop()!;
    let resumed = false;
    try {
      resumed = candidate.resume?.(drained) === true;
    } catch {
      /* a standby that throws cannot produce; try the next */
    }
    if (resumed) break;
  }
  forgetIfEmpty(r, agentId, waiting);
}

/**
 * Take `generation` off `agentId`'s standby. A superseded copy whose host then
 * unloads it (OpenClaw's ordinary reload) could never resume; left listed, it
 * would pin its whole module graph until the active holder's next release.
 */
export function withdrawAgentRuntimeStandby(agentId: string, generation: number): void {
  const r = registry();
  const waiting = r.standby?.get(agentId);
  if (!waiting) return;
  dropStandby(waiting, generation);
  forgetIfEmpty(r, agentId, waiting);
}

/**
 * Drop the map entry for `waiting` once it is empty — but only while it IS
 * the agent's current list: a re-entrant claim during a resume may already
 * have replaced it with a fresh list that holds the next standby.
 */
function forgetIfEmpty(r: RuntimeRegistry, agentId: string, waiting: AgentRuntimeHolder[]): void {
  if (waiting.length === 0 && r.standby?.get(agentId) === waiting) r.standby.delete(agentId);
}

function standbyFor(r: RuntimeRegistry, agentId: string): AgentRuntimeHolder[] {
  const m = (r.standby ??= new Map());
  let list = m.get(agentId);
  if (!list) {
    list = [];
    m.set(agentId, list);
  }
  return list;
}

function dropStandby(list: AgentRuntimeHolder[], generation: number): void {
  const i = list.findIndex((h) => h.generation === generation);
  if (i >= 0) list.splice(i, 1);
}

/** Test seam: generations waiting to resume `agentId`, oldest first. */
export function agentRuntimeStandbyGenerations(agentId: string): number[] {
  return (registry().standby?.get(agentId) ?? []).map((h) => h.generation);
}

/** Test seam: the generation currently holding `agentId`, if any. */
export function agentRuntimeGeneration(agentId: string): number | undefined {
  return registry().byAgent.get(agentId)?.generation;
}

/**
 * Run `fn` (an enrol-or-load) with every other module copy's enrol-or-load for
 * the same `key` queued behind it. An enrolment token is single-use, and the
 * agent id that keys the producer claim above only exists once it succeeds:
 * a copy retired mid-enrolment (a reload) has spent the token while the new
 * copy, finding no credentials yet, would spend it again and get a 400 — so
 * neither would produce. Queued here, the new copy runs once the old one's
 * enrolment has settled and loads the credentials it saved.
 */
export async function runEnrolmentExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const r = registry();
  // Added after the first registry shape: an older copy may have created it.
  const locks = (r.enrolments ??= new Map());
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** Leave an enrolment's operator keys for the copy that pins them (TOFU). */
export function putEnrolOperatorKeys(key: string, keys: unknown[]): void {
  (registry().enrolOperatorKeys ??= new Map()).set(key, keys);
}

/** Take (once) the operator keys an enrolment under `key` left behind. */
export function takeEnrolOperatorKeys(key: string): unknown[] | null {
  const m = registry().enrolOperatorKeys;
  const keys = m?.get(key) ?? null;
  m?.delete(key);
  return keys;
}
