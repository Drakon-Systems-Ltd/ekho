import type { DeadLetterReason } from "@drakon-systems/ekho-sdk";

// #111 S2b-1: the plugin's precise internal reasons, reduced to the coarse
// values a sender may be told. Pure: no state, no I/O. The strings are written
// out (autoreply.ts imports this module, so it cannot import them back); each
// names its constant in autoreply.ts, and tests/delivery-disposition.test.ts
// compares them with the exports so a rename goes red.
const SAME_VALUE: ReadonlySet<string> = new Set<DeadLetterReason>([
  "deferred_evicted_cap", // DEFERRED_EVICTED_REASON
  "deferred_overflow_per_conv", // DEFERRED_OVERFLOW_REASON
  "deferred_expired_spawn_failed", // DEFERRED_SPAWN_FAILED_REASON
  "deferred_retry_spawn_failed" // DEFERRED_RETRY_SPAWN_FAILED_REASON
]);
const WITHHELD_PREFIX = "reload_withheld:"; // RELOAD_WITHHELD_PREFIX

/**
 * The coarse reason for an internal dead-letter reason, or null when nothing
 * should be reported: a stop (a successor may still serve it), a re-admission,
 * a duplicate, or anything not recognised. Never throws.
 */
export function coarseDeadLetterReason(internal: unknown): DeadLetterReason | null {
  if (typeof internal !== "string" || internal === "") return null;
  if (SAME_VALUE.has(internal)) return internal as DeadLetterReason;
  if (!internal.startsWith(WITHHELD_PREFIX)) return null;
  const why = internal.slice(WITHHELD_PREFIX.length);
  if (why === "expired" || why === "no_deadline") return "deadline_passed";
  if (why === "handoff_overflow" || why === "handoff_unclaimed_too_long") return "handoff_unclaimed";
  return "withheld_by_recipient";
}
