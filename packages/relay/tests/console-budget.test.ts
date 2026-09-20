import { describe, it, expect } from "vitest";
// Pure console helpers for the opt-in turn limit. No React/DOM.
import { budgetLabel, budgetInputValue, parseBudgetInput, savedBudget } from "../frontend/src/budget.js";

describe("console turn-limit helpers", () => {
  it("labels an unset budget 'no limit' and never invents a number", () => {
    for (const unset of [null, undefined, 0, -3, "", Number.NaN]) {
      expect(budgetLabel(unset)).toBe("no limit");
      expect(budgetInputValue(unset)).toBe(""); // blank input → placeholder "No limit"
      expect(savedBudget(unset)).toBe(0);
    }
    expect(budgetLabel(25)).toBe("25");
    expect(budgetInputValue(40)).toBe("40");
    expect(savedBudget(40)).toBe(40);
  });

  it("parses operator input: blank/0 clears, positive is clamped, junk is rejected", () => {
    expect(parseBudgetInput("", 200)).toBe(0);
    expect(parseBudgetInput("   ", 200)).toBe(0);
    expect(parseBudgetInput("0", 200)).toBe(0);
    expect(parseBudgetInput("12", 200)).toBe(12);
    expect(parseBudgetInput("12.9", 200)).toBe(12);
    expect(parseBudgetInput("0.4", 200)).toBe(0);
    expect(parseBudgetInput("9999", 200)).toBe(200);
    expect(parseBudgetInput("9999", 500)).toBe(500);
    expect(parseBudgetInput("-5", 200)).toBeNull();
    expect(parseBudgetInput("abc", 200)).toBeNull();
  });
});
