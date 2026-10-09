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
}

interface RuntimeRegistry {
  /** Last generation handed out; module copies take the next one at load. */
  generations: number;
  byAgent: Map<string, AgentRuntimeHolder>;
  /** Tail of each enrolment key's lock queue (see runEnrolmentExclusive). */
  enrolments?: Map<string, Promise<void>>;
  /** Operator keys from an enrolment, for whichever copy bootstraps identity. */
  enrolOperatorKeys?: Map<string, unknown[]>;
  /** Acked work a stopping loop left for its same-process successor (#111). */
  reloadHandoffs?: Map<string, ReloadHandoffEntry[]>;
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
 */
export function claimAgentRuntime(agentId: string, holder: AgentRuntimeHolder): boolean {
  const r = registry();
  const current = r.byAgent.get(agentId);
  if (current && current.generation > holder.generation) return false;
  if (current && current.generation !== holder.generation) {
    try {
      current.stop(`superseded by generation ${holder.generation}`);
    } catch {
      /* the old copy is going away regardless */
    }
  }
  r.byAgent.set(agentId, holder);
  return true;
}

/** Drop `agentId`'s entry if (and only if) this generation still holds it. */
export function releaseAgentRuntime(agentId: string, generation: number): void {
  const r = registry();
  if (r.byAgent.get(agentId)?.generation === generation) r.byAgent.delete(agentId);
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

// ---- Reload hand-off (#111) -------------------------------------------------
// A stopping loop's acked-but-unserved messages, left for the NEXT generation
// in this same process. The host's reload swaps generations seconds apart, and
// before this the successor started with an empty stash: a message still well
// inside its deadline was on disk as a dead-letter record and nowhere else.
//
// What this is NOT, on purpose:
//  - Not a queue authority. An entry is a candidate the successor RE-ADMITS
//    under its own trust root, policy, floor and deadline; it carries no
//    verdict, and one written by any bundle version is treated as untrusted.
//  - Not durable. It lives in this process's memory only. A gateway shutdown
//    or a crash loses it exactly as before, and the dead-letter file (which is
//    still written, unchanged) is never read back as work.
//  - Not shared across connection domains. An entry is taken only by a holder
//    with the same full ownership identity (relay, agent, fleet, agent signing
//    key) and a strictly newer generation that currently holds the agent.

/** Upper bound on entries held per agent. Matches the most a loop can hold in
 *  its stash (autoreply.ts DEFERRED_CONVERSATION_CAP x DEFERRED_MESSAGES_PER_CONV). */
export const RELOAD_HANDOFF_CAP = 500;
/** An entry nobody claimed within this long is dropped (and reported). Same
 *  bound as the signed-freshness window: past it a signed message is stale. */
export const RELOAD_HANDOFF_MAX_AGE_MS = (86400 + 300) * 1000;

export interface ReloadHandoffEntry {
  /** Connection identity of the depositing loop (see autoreply.ts inboxCacheContext). */
  owner: string;
  agentId: string;
  fromGeneration: number;
  /** Why the stopping loop let go of it (deferred_loop_stopped / inflight_loop_stopped). */
  reason: string;
  conversationId: string;
  /** The message as the depositor held it. Untrusted: re-verified on admission. */
  message: unknown;
  /** When the message was first deferred to a floor holder; null if never. */
  firstDeferredAtMs: number | null;
  depositedAtMs: number;
}

/** What a deposit or take could not keep, for the caller to report. */
export interface ReloadHandoffDropped {
  entry: ReloadHandoffEntry;
  why: "overflow" | "unclaimed_too_long";
}

function handoffStore(): Map<string, ReloadHandoffEntry[]> {
  const r = registry();
  // Added after the first registry shape: an older copy may not have created it.
  if (r.reloadHandoffs instanceof Map) return r.reloadHandoffs;
  const store = new Map<string, ReloadHandoffEntry[]>();
  r.reloadHandoffs = store;
  return store;
}

function isHandoffEntry(e: unknown): e is ReloadHandoffEntry {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.owner === "string" && x.owner !== "" &&
    typeof x.agentId === "string" && x.agentId !== "" &&
    typeof x.fromGeneration === "number" && Number.isFinite(x.fromGeneration) &&
    typeof x.conversationId === "string" &&
    typeof x.depositedAtMs === "number" && Number.isFinite(x.depositedAtMs)
  );
}

/** Drop entries past the age bound or the per-agent cap (oldest first). */
function pruneHandoffs(list: ReloadHandoffEntry[], nowMs: number): ReloadHandoffDropped[] {
  const dropped: ReloadHandoffDropped[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (nowMs - list[i].depositedAtMs > RELOAD_HANDOFF_MAX_AGE_MS) {
      dropped.push({ entry: list[i], why: "unclaimed_too_long" });
      list.splice(i, 1);
    }
  }
  while (list.length > RELOAD_HANDOFF_CAP) {
    const oldest = list.shift();
    if (oldest) dropped.push({ entry: oldest, why: "overflow" });
  }
  return dropped;
}

/**
 * Leave `entries` for a successor of the same agent. Synchronous, so a stop
 * that deposits has done so before it returns. Never throws. Returns what the
 * bounds pushed out (the oldest entries first), which the caller reports.
 */
export function depositReloadHandoff(entries: ReloadHandoffEntry[], nowMs = Date.now()): ReloadHandoffDropped[] {
  const store = handoffStore();
  const dropped: ReloadHandoffDropped[] = [];
  const touched = new Set<string>();
  for (const e of entries) {
    if (!isHandoffEntry(e)) continue;
    const list = store.get(e.agentId) ?? [];
    list.push(e);
    store.set(e.agentId, list);
    touched.add(e.agentId);
  }
  for (const agentId of touched) {
    const list = store.get(agentId) ?? [];
    dropped.push(...pruneHandoffs(list, nowMs));
    if (list.length === 0) store.delete(agentId);
  }
  return dropped;
}

/**
 * Take, once, the entries left for `agentId` by OLDER generations with the
 * same full ownership identity. Only the generation that currently holds the
 * agent may take; a stale or retired copy gets nothing. Entries from another
 * connection domain (a different relay, fleet or signing key) are left where
 * they are, untouched, for their own owner or the bounds. Take-and-delete is
 * one synchronous step, so two takers can never both receive an entry.
 */
export function takeReloadHandoff(
  agentId: string,
  owner: string,
  takerGeneration: number,
  nowMs = Date.now()
): { taken: ReloadHandoffEntry[]; dropped: ReloadHandoffDropped[] } {
  const r = registry();
  if (!agentId || !owner) return { taken: [], dropped: [] };
  if (r.byAgent.get(agentId)?.generation !== takerGeneration) return { taken: [], dropped: [] };
  const store = handoffStore();
  const list = store.get(agentId);
  if (!list) return { taken: [], dropped: [] };
  const dropped = pruneHandoffs(list, nowMs);
  const taken: ReloadHandoffEntry[] = [];
  const left: ReloadHandoffEntry[] = [];
  for (const e of list) {
    if (isHandoffEntry(e) && e.agentId === agentId && e.owner === owner && e.fromGeneration < takerGeneration) {
      taken.push(e);
    } else {
      left.push(e);
    }
  }
  if (left.length > 0) store.set(agentId, left);
  else store.delete(agentId);
  return { taken, dropped };
}

/** Test seam: how many hand-off entries are held for `agentId`. */
export function reloadHandoffCount(agentId: string): number {
  return registry().reloadHandoffs?.get(agentId)?.length ?? 0;
}
