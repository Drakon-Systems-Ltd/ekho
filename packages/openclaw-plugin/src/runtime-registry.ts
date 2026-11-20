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
  /** Acked work a stopping loop left for its same-process successor (#111). */
  reloadHandoffs?: Map<string, ReloadHandoffEntry[]>;
  /** Which loop (by epoch) last took ownership of a message or signature (#111). */
  reloadServed?: Map<string, ReloadServedLedger>;
  /** Last loop epoch handed out (#111); see nextReloadEpoch. */
  reloadEpochs?: number;
  /** Newest epoch recorded in any served ledger dropped WHOLE (#111). */
  reloadServedFloor?: { key?: number; nonce?: number };
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
//  - Not shared across connection domains. An entry is taken only by a loop
//    with the same full ownership identity (relay, agent, fleet, agent signing
//    key), started later than the depositor, in the module copy that currently
//    holds the agent.
//
// "Later" is a loop EPOCH, not the module generation. Generations order module
// copies, and that order is not the order loops run in: a superseded copy
// resumes when its successor is disposed (#160), so an older generation can be
// the newest producer, and one copy restarts its loop on a lifecycle re-apply
// (rebindAutoReply). Every loop start takes the next epoch from this registry,
// so "deposited by an earlier loop" and "served by a later loop" stay true
// across both. The generation still decides who holds the agent.

/** A fresh, process-wide loop epoch. Call once per auto-reply loop start. */
export function nextReloadEpoch(): number {
  const r = registry();
  const next = (typeof r.reloadEpochs === "number" && Number.isFinite(r.reloadEpochs) ? r.reloadEpochs : 0) + 1;
  r.reloadEpochs = next;
  return next;
}

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
  /** Epoch of the depositing loop (nextReloadEpoch): what orders hand-offs. */
  fromEpoch: number;
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

/**
 * The entry a stored or deposited value describes, as a plain copy, or null.
 * The registry is shared by every bundle version in the process, so a value in
 * it may have any shape, including a property accessor that throws (#192).
 * Each field is read exactly ONCE, in isolation: a value that is not an entry,
 * or whose read throws, is simply not an entry. Nothing after this — the
 * bounds, the take, the caller's report of what was dropped — reads the
 * original object again, so an accessor that answers its first read and throws
 * on a later one has no later read to throw on. `message` is carried as found:
 * it stays untrusted and is re-verified on admission, as before.
 */
function readHandoffEntry(e: unknown): ReloadHandoffEntry | null {
  if (!e || typeof e !== "object") return null;
  try {
    const { owner, agentId, fromGeneration, fromEpoch, reason, conversationId, message, firstDeferredAtMs, depositedAtMs } =
      e as ReloadHandoffEntry;
    const ok =
      typeof owner === "string" && owner !== "" &&
      typeof agentId === "string" && agentId !== "" &&
      typeof fromGeneration === "number" && Number.isFinite(fromGeneration) &&
      typeof fromEpoch === "number" && Number.isFinite(fromEpoch) &&
      typeof conversationId === "string" &&
      typeof depositedAtMs === "number" && Number.isFinite(depositedAtMs);
    return ok ? { owner, agentId, fromGeneration, fromEpoch, reason, conversationId, message, firstDeferredAtMs, depositedAtMs } : null;
  } catch {
    return null;
  }
}

/**
 * One isolated pass over what is held for an agent, plus `added`: the entries
 * that remain, as plain copies in a NEW list, and what the bounds pushed out
 * (past the age bound, then oldest first past the per-agent cap). The stored
 * list is copied once and never touched again; if even that throws (#192: it
 * cannot be walked) nothing in it is kept, so the caller replaces the agent's
 * slot instead of failing every later take and deposit.
 */
function pruneHandoffs(
  held: unknown,
  nowMs: number,
  added: ReloadHandoffEntry[] = []
): { kept: ReloadHandoffEntry[]; dropped: ReloadHandoffDropped[] } {
  let all: unknown[] = added;
  try {
    if (Array.isArray(held)) all = [...held, ...added];
  } catch {
    /* an unwalkable list: only `added` is considered */
  }
  const kept: ReloadHandoffEntry[] = [];
  const dropped: ReloadHandoffDropped[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    // Not an entry at all, or one that cannot be read (another bundle version
    // wrote it): it can never be taken, and must not make every later take
    // and deposit throw. It is dropped alone and is not reported.
    const entry = readHandoffEntry(all[i]);
    if (!entry) continue;
    if (nowMs - entry.depositedAtMs > RELOAD_HANDOFF_MAX_AGE_MS) dropped.push({ entry, why: "unclaimed_too_long" });
    else kept.push(entry);
  }
  kept.reverse();
  while (kept.length > RELOAD_HANDOFF_CAP) {
    const oldest = kept.shift();
    if (oldest) dropped.push({ entry: oldest, why: "overflow" });
  }
  return { kept, dropped };
}

/**
 * Leave `entries` for a successor of the same agent. Synchronous, so a stop
 * that deposits has done so before it returns. Never throws. Returns what the
 * bounds pushed out, which the caller reports: entries past the age bound
 * (newest first), then entries past the per-agent cap (oldest first).
 */
export function depositReloadHandoff(entries: ReloadHandoffEntry[], nowMs = Date.now()): ReloadHandoffDropped[] {
  const store = handoffStore();
  const dropped: ReloadHandoffDropped[] = [];
  const added = new Map<string, ReloadHandoffEntry[]>();
  for (const raw of entries) {
    const e = readHandoffEntry(raw);
    if (!e) continue;
    const list = added.get(e.agentId) ?? [];
    list.push(e);
    added.set(e.agentId, list);
  }
  for (const [agentId, list] of added) {
    const pruned = pruneHandoffs(store.get(agentId), nowMs, list);
    dropped.push(...pruned.dropped);
    if (pruned.kept.length > 0) store.set(agentId, pruned.kept);
    else store.delete(agentId);
  }
  return dropped;
}

/**
 * Take, once, the entries left for `agentId` by EARLIER loops (a lower epoch)
 * with the same full ownership identity. Only the generation that currently
 * holds the agent may take; a stale or retired copy gets nothing. Entries from another
 * connection domain (a different relay, fleet or signing key) are left where
 * they are, untouched, for their own owner or the bounds. Take-and-delete is
 * one synchronous step, so two takers can never both receive an entry.
 * Never throws.
 */
export function takeReloadHandoff(
  agentId: string,
  owner: string,
  takerGeneration: number,
  takerEpoch: number,
  nowMs = Date.now()
): { taken: ReloadHandoffEntry[]; dropped: ReloadHandoffDropped[] } {
  const r = registry();
  if (!agentId || !owner) return { taken: [], dropped: [] };
  if (r.byAgent.get(agentId)?.generation !== takerGeneration) return { taken: [], dropped: [] };
  const store = handoffStore();
  const { kept, dropped } = pruneHandoffs(store.get(agentId), nowMs);
  const taken: ReloadHandoffEntry[] = [];
  const left: ReloadHandoffEntry[] = [];
  // `kept` holds only plain copies the prune just made: these reads cannot throw.
  for (const e of kept) {
    if (e.agentId === agentId && e.owner === owner && e.fromEpoch < takerEpoch) {
      taken.push(e);
    } else {
      left.push(e);
    }
  }
  if (left.length > 0) store.set(agentId, left);
  else store.delete(agentId);
  return { taken, dropped };
}

// ---- Served ledger (#111) ----------------------------------------------------
// A loop's `seen` and nonce sets die with it, so a deposit can outlive every
// generation that knew its message was already served: A's covering turn fails
// after A was retired, B serves the relay's redelivery, B is replaced by C, and
// A's late flush then lands in C. This ledger, scoped to one connection domain
// (agent + owner), remembers the NEWEST generation that took ownership of a
// message (its heldKey) or accepted a signature (its nonce). A hand-off entry
// whose message a NEWER generation than its depositor already served is a
// duplicate. The depositor's own ownership does not count against it, so
// unserved work still carries B -> C.
//
// What it records is ownership, never trust: no verdict, no payload. It is
// bounded and in memory only, like the hand-off itself; it is consulted by the
// hand-off alone, not by fresh relay deliveries.
//
// "Generation" above is history: what orders loops is the loop EPOCH (see the
// hand-off notes), and that is what these functions take and return. The
// stored record keeps its field name, `generation`: the records live in the
// process-wide registry and are read by whichever bundle versions are loaded,
// so renaming the field would hide one version's records from another.

/** Most keys (and, separately, nonces) remembered per connection domain. Four
 *  times the most a hand-off can hold, so the evidence outlives the entries. */
export const RELOAD_SERVED_CAP = 4 * RELOAD_HANDOFF_CAP;
/** Connection domains remembered per process, oldest forgotten first. */
const RELOAD_SERVED_DOMAINS = 64;

interface ReloadServedLedger {
  keys: Map<string, { generation: number; atMs: number }>;
  nonces: Map<string, { generation: number; atMs: number }>;
  /** Newest loop epoch among the records the bounds have pushed out, per
   *  kind. Past it the ledger can no longer say "nobody later served this". */
  forgotten?: { key?: number; nonce?: number };
}

function servedStore(): Map<string, ReloadServedLedger> {
  const r = registry();
  if (r.reloadServed instanceof Map) return r.reloadServed;
  const store = new Map<string, ReloadServedLedger>();
  r.reloadServed = store;
  return store;
}

const servedDomain = (agentId: string, owner: string): string => `${agentId}\u0000${owner}`;

function noteInto(
  map: ReloadServedLedger["keys"],
  values: string[],
  epoch: number,
  nowMs: number
): number | undefined {
  let forgotten: number | undefined;
  const forget = (e: { generation: number } | undefined): void => {
    if (e && Number.isFinite(e.generation)) forgotten = Math.max(forgotten ?? e.generation, e.generation);
  };
  // A stored record's two fields, each read once, in isolation (#192). One
  // that cannot be read is lost evidence, not "nobody served this": what it
  // said is unknowable, so every earlier loop's hand-offs are withheld.
  const read = (e: unknown): { generation: number; atMs: number } | undefined => {
    try {
      const { generation, atMs } = (e ?? {}) as { generation: number; atMs: number };
      return { generation, atMs };
    } catch {
      forgotten = Number.POSITIVE_INFINITY;
      return undefined;
    }
  };
  for (const v of values) {
    if (typeof v !== "string" || !v) continue;
    const prior = read(map.get(v));
    // Re-insert so iteration stays oldest-first; keep the newest owner.
    map.delete(v);
    map.set(v, { generation: Math.max(epoch, prior?.generation ?? epoch), atMs: nowMs });
  }
  for (const [v, raw] of map) {
    const e = read(raw);
    if (e && nowMs - e.atMs <= RELOAD_HANDOFF_MAX_AGE_MS) break;
    forget(e);
    map.delete(v);
  }
  while (map.size > RELOAD_SERVED_CAP) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    forget(read(map.get(oldest)));
    map.delete(oldest);
  }
  return forgotten;
}

/** Record that the loop with this `epoch` took ownership of these messages
 *  (heldKeys) and accepted these signatures (nonces). */
export function noteReloadServed(
  agentId: string,
  owner: string,
  epoch: number,
  served: { keys?: string[]; nonces?: string[] },
  nowMs = Date.now()
): void {
  if (!agentId || !owner || !Number.isFinite(epoch)) return;
  const store = servedStore();
  const domain = servedDomain(agentId, owner);
  let ledger = store.get(domain);
  if (!ledger) {
    ledger = { keys: new Map(), nonces: new Map() };
    store.set(domain, ledger);
    while (store.size > RELOAD_SERVED_DOMAINS) {
      const oldest = store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      // A ledger dropped whole takes its evidence with it. Keep the newest
      // epoch it held as a process-wide floor: which domain it belonged to is
      // not remembered, so every domain's older hand-offs are withheld.
      forgetDomain(store.get(oldest));
      store.delete(oldest);
    }
  }
  const lostKey = noteInto(ledger.keys, served.keys ?? [], epoch, nowMs);
  const lostNonce = noteInto(ledger.nonces, served.nonces ?? [], epoch, nowMs);
  if (lostKey !== undefined || lostNonce !== undefined) {
    const f = (ledger.forgotten ??= {});
    if (lostKey !== undefined) f.key = Math.max(f.key ?? lostKey, lostKey);
    if (lostNonce !== undefined) f.nonce = Math.max(f.nonce ?? lostNonce, lostNonce);
  }
}

/**
 * The newest loop epoch whose ownership record of some message (or signature)
 * the ledger's bounds have already pushed out, if any. A hand-off entry left
 * by an EARLIER loop than that cannot be shown to be unserved any more: the
 * record that would call it a duplicate may be the one that was dropped. The
 * hand-off withholds such an entry (with a record) instead of risking a
 * second turn. A domain the per-process bound dropped whole (64 other
 * connection identities in one process) leaves its newest epoch as a floor
 * that applies to every domain.
 */
export function reloadServedForgotten(agentId: string, owner: string, kind: "key" | "nonce"): number | undefined {
  const r = registry();
  const own = r.reloadServed?.get(servedDomain(agentId, owner))?.forgotten?.[kind];
  const floor = r.reloadServedFloor?.[kind];
  if (typeof own !== "number") return typeof floor === "number" ? floor : undefined;
  return typeof floor === "number" ? Math.max(own, floor) : own;
}

/** Fold a ledger that is being dropped whole into the process-wide floor. */
function forgetDomain(ledger: ReloadServedLedger | undefined): void {
  if (!ledger) return;
  const r = registry();
  const floor = (r.reloadServedFloor ??= {});
  const raise = (kind: "key" | "nonce", epoch: unknown): void => {
    // +Infinity is the lost-evidence mark (#192): it must survive the fold.
    if (typeof epoch !== "number" || Number.isNaN(epoch) || epoch === Number.NEGATIVE_INFINITY) return;
    floor[kind] = Math.max(floor[kind] ?? epoch, epoch);
  };
  try {
    raise("key", ledger.forgotten?.key);
    raise("nonce", ledger.forgotten?.nonce);
    for (const e of ledger.keys?.values?.() ?? []) raise("key", e?.generation);
    for (const e of ledger.nonces?.values?.() ?? []) raise("nonce", e?.generation);
  } catch {
    /* a ledger another bundle version shaped differently: nothing to fold */
  }
}

/** The epoch of the newest loop that took ownership of `value` (a heldKey, or
 *  a signature nonce) in this connection domain, if any is remembered. */
export function reloadServedBy(
  agentId: string,
  owner: string,
  kind: "key" | "nonce",
  value: string
): number | undefined {
  const ledger = registry().reloadServed?.get(servedDomain(agentId, owner));
  return (kind === "key" ? ledger?.keys : ledger?.nonces)?.get(value)?.generation;
}

/** Test seam: how many hand-off entries are held for `agentId`. */
export function reloadHandoffCount(agentId: string): number {
  return registry().reloadHandoffs?.get(agentId)?.length ?? 0;
}
