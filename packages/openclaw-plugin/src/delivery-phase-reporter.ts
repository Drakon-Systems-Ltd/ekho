import type { DeadLetterReason, DeliveryPhaseEntry, DeliveryPhasesResult } from "@drakon-systems/ekho-sdk";

/**
 * Standalone best-effort reporter for the `dead_lettered` delivery phase (#111, S2a).
 * Nothing calls it yet. Type-only SDK imports: no run-time dependency on the SDK or any plugin module.
 */

// Mirrors DEAD_LETTER_REASONS in packages/sdk/src/types.ts. Written out so no run-time SDK import is needed;
// only these coarse values may reach a sender.
const REASONS: ReadonlySet<string> = new Set([
  "deferred_evicted_cap", "deferred_overflow_per_conv", "deferred_expired_spawn_failed", "deferred_retry_spawn_failed", "deferred_loop_stopped",
  "deadline_passed", "withheld_by_recipient", "handoff_unclaimed", "inflight_loop_stopped", "recovery_unavailable"
]);

const MAX_ID = 200;
const RING = 500;
const SENT_MEMORY = 1000;
const MAX_CALLS_PER_FLUSH = 20;
const MAX_ATTEMPTS = 3;
// SDK error text: `Ekho request failed for /v1/delivery-phases: <status> ...`
const STATUS_RE = /^Ekho request failed for \/v1\/delivery-phases: (\d{3})(?:\s|$)/;

export type DeadLetterReporterOptions = {
  post: (phases: DeliveryPhaseEntry[]) => Promise<DeliveryPhasesResult>;
  now: () => number;
  log: (line: string) => void;
};

export type DeadLetterReporter = {
  enqueue(messageId: string, reason: string): void;
  flush(): Promise<void>;
  pending(): number;
  disabled(): boolean;
};

type Entry = { id: string; reason: string; at: string; attempts: number };

export function createDeadLetterReporter(opts: DeadLetterReporterOptions): DeadLetterReporter {
  const queue: Entry[] = [];
  const queued = new Set<string>();
  const sent = new Set<string>();
  let warnedBadReason = false;
  const logged400 = new Set<string>();
  let off = false;
  let overflowed = false;
  let running: Promise<void> | null = null;
  // The entry whose POST is pending. It stays in `queue` and `queued` until it settles, and overflow never evicts it.
  let inflight: Entry | null = null;

  const log = (line: string): void => {
    try { opts.log(line); } catch { /* logging never breaks reporting */ }
  };
  const remember = (id: string): void => {
    sent.add(id);
    if (sent.size > SENT_MEMORY) sent.delete(sent.values().next().value as string);
  };
  const remove = (entry: Entry): void => {
    const i = queue.indexOf(entry);
    if (i >= 0) queue.splice(i, 1);
    queued.delete(entry.id);
  };

  function enqueue(messageId: string, reason: string): void {
    try {
      if (off) return;
      if (typeof messageId !== "string" || messageId.length === 0 || messageId.length > MAX_ID) return;
      if (typeof reason !== "string" || !REASONS.has(reason)) {
        // Fixed text, once per instance: the rejected value is never stored or logged.
        if (!warnedBadReason) {
          warnedBadReason = true;
          log("delivery-phase: dropped a report with a reason outside the closed set (further drops not logged)");
        }
        return;
      }
      if (queued.has(messageId) || sent.has(messageId)) return;
      const at = new Date(opts.now()).toISOString();
      queue.push({ id: messageId, reason, at, attempts: 0 });
      queued.add(messageId);
      if (queue.length > RING) {
        const at0 = queue[0] === inflight ? 1 : 0;
        const [oldest] = queue.splice(at0, 1);
        queued.delete(oldest!.id);
        overflowed = true;
      }
    } catch {
      /* enqueue never throws */
    }
  }

  async function run(): Promise<void> {
    if (overflowed) {
      overflowed = false;
      log(`delivery-phase: ring full, oldest pending reports dropped (limit ${RING})`);
    }
    for (let calls = 0; calls < MAX_CALLS_PER_FLUSH && !off; calls++) {
      const entry = queue[0];
      if (!entry) return;
      inflight = entry;
      try {
        await opts.post([{ message_id: entry.id, phase: "dead_lettered", at: entry.at, reason: entry.reason as DeadLetterReason }]);
        inflight = null;
        remove(entry);
        remember(entry.id);
      } catch (err) {
        inflight = null;
        const text = err instanceof Error ? err.message : "";
        const status = Number(STATUS_RE.exec(text)?.[1] ?? 0);
        if (status === 404) {
          off = true;
          queue.length = 0;
          queued.clear();
          log("delivery-phase: relay has no delivery-phases route, reporting off for this run");
          return;
        }
        if (status === 400) {
          remove(entry);
          remember(entry.id);
          if (!logged400.has(entry.reason)) {
            logged400.add(entry.reason);
            log(`delivery-phase: relay rejected report id=${entry.id} reason=${entry.reason}`);
          }
          continue;
        }
        entry.attempts += 1;
        if (entry.attempts >= MAX_ATTEMPTS) {
          remove(entry);
          log(`delivery-phase: gave up after ${MAX_ATTEMPTS} attempts id=${entry.id} reason=${entry.reason}`);
        }
        return;
      }
    }
  }

  function flush(): Promise<void> {
    if (running) return running;
    running = run().catch(() => undefined).finally(() => { running = null; });
    return running;
  }

  return { enqueue, flush, pending: () => queue.length, disabled: () => off };
}
