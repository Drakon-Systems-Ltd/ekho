// Peer turn budgets are opt-in. The relay reports `null` for "no limit" (the
// default) and a positive integer for a cap the operator set. Pure helpers, no
// React/DOM, shared by every console surface so the wording can't drift.

/** Human label for a budget value: "no limit" unless a positive cap is set. */
export function budgetLabel(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? String(n) : "no limit";
}

/** Value for a number <input>: blank (placeholder shows "No limit") when unset. */
export function budgetInputValue(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? String(n) : "";
}

/**
 * Parse what the operator typed into a budget input.
 *   blank or 0      -> 0     (clear the cap: no limit)
 *   positive integer -> clamped to [1, max]
 *   anything else   -> null  (invalid: caller reverts, sends nothing). A
 *                      fraction is invalid, never truncated: "0.4" must not
 *                      silently become 0 and clear an existing cap.
 */
export function parseBudgetInput(raw, max) {
  const text = String(raw ?? "").trim();
  if (text === "") return 0;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0) return null;
  if (n === 0) return 0;
  return Math.min(max, n);
}

/** Normalise a relay value (null | number) to the 0-or-positive form the inputs compare on. */
export function savedBudget(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
