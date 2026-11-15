/**
 * #155 — query-time `fetch_wait` classification (design §2.3).
 *
 * An adapter does not poll while it runs a turn, so a message that arrives
 * mid-turn stays `queued` at the relay exactly as it would if the adapter's
 * inbox loop had stalled. The relay tells the two apart after the fact from
 * the recipient's own retained turn-attempt intervals (`delivery_turn_attempts`),
 * not from the latest heartbeat: an idle heartbeat sent between the end of a
 * turn and the next fetch would erase the evidence.
 *
 * Nothing here is stored. The label is derived on every read, so a late
 * `turn_ended` report reclassifies the gap.
 *
 * Approximate, and to be labelled so wherever it is shown:
 *  - the gap is relay clock, the intervals are adapter clock (each already
 *    clamped to within 24 h of relay time when it was recorded). No per-agent
 *    clock offset is applied yet; that needs the adapter's `last_poll_at`
 *    heartbeat metric, which no adapter sends today.
 *  - a dropped or never-sent report makes busy time read as `inbox_stalled`,
 *    so `adapter_busy` is a lower bound.
 */

export type FetchWait = "prompt" | "adapter_busy" | "inbox_stalled";

/** Share of the fetch gap that retained turn intervals must cover for `adapter_busy`. */
export const FETCH_WAIT_BUSY_COVERAGE = 0.8;

export interface TurnInterval {
  startedAt: string | null;
  endedAt: string | null;
}

export interface FetchWaitInput {
  queuedAt: string | null;
  /** Relay time the adapter fetched the delivery. Null = not fetched. */
  deliveredAt: string | null;
  /** How many times the delivery has been fetched. */
  deliveryAttempts: number;
  /** Turn intervals of the recipient agent. Order and overlap do not matter. */
  intervals: readonly TurnInterval[];
  /** A gap up to and including this is `prompt`. */
  staleMs: number;
  /** Longest a single interval may count for; also the assumed length of an open one. */
  capMs: number;
}

/**
 * The fetch gap `[queuedAt, deliveredAt]`, or null when there is no single
 * plain fetch wait to classify: not fetched yet, unreadable timestamps, or
 * fetched more than once (the gap then spans an earlier fetch and the retry
 * back-off, so neither `adapter_busy` nor `inbox_stalled` would be honest).
 */
export function fetchGap(input: Pick<FetchWaitInput, "queuedAt" | "deliveredAt" | "deliveryAttempts">): { start: number; end: number } | null {
  if (!input.queuedAt || !input.deliveredAt) return null;
  if (input.deliveryAttempts > 1) return null;
  const start = Date.parse(input.queuedAt);
  const end = Date.parse(input.deliveredAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

export function classifyFetchWait(input: FetchWaitInput): FetchWait | null {
  const gap = fetchGap(input);
  if (!gap) return null;
  const length = gap.end - gap.start;
  if (length <= Math.max(0, input.staleMs)) return "prompt";

  // Clip every interval to the gap, then measure the union.
  const pieces: Array<[number, number]> = [];
  for (const interval of input.intervals) {
    if (!interval.startedAt) continue;
    const from = Date.parse(interval.startedAt);
    if (!Number.isFinite(from)) continue;
    const cap = from + Math.max(0, input.capMs);
    const reported = interval.endedAt ? Date.parse(interval.endedAt) : NaN;
    const to = Number.isFinite(reported) ? Math.min(reported, cap) : cap;
    const a = Math.max(from, gap.start);
    const b = Math.min(to, gap.end);
    if (b > a) pieces.push([a, b]);
  }
  pieces.sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let reach = gap.start;
  for (const [a, b] of pieces) {
    if (b <= reach) continue;
    covered += b - Math.max(a, reach);
    reach = b;
  }
  return covered >= FETCH_WAIT_BUSY_COVERAGE * length ? "adapter_busy" : "inbox_stalled";
}
