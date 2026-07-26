import { describe, it, expect } from "vitest";
import {
  resolveBootstrapPassword,
  generateBootstrapPassword,
  MIN_BOOTSTRAP_PASSWORD_LENGTH
} from "../src/bootstrap-credentials";

// Imports the pure module only — never setup.ts, which runs the wizard on import.
describe("bootstrap password policy", () => {
  it("never falls back to the old hardcoded default", () => {
    const resolved = resolveBootstrapPassword(undefined);
    expect(resolved.password).not.toBe("changeme123");
    expect(resolved.generated).toBe(true);
  });

  it("generates a strong password when none is supplied", () => {
    const resolved = resolveBootstrapPassword(undefined);
    expect(resolved.generated).toBe(true);
    expect(resolved.password.length).toBeGreaterThanOrEqual(MIN_BOOTSTRAP_PASSWORD_LENGTH);
    expect(resolved.warning).toBeUndefined();
  });

  it("treats an empty or whitespace value as unset rather than as a password", () => {
    for (const blank of ["", "   ", "\t"]) {
      const resolved = resolveBootstrapPassword(blank);
      expect(resolved.generated).toBe(true);
      expect(resolved.password.trim()).toBe(resolved.password);
    }
  });

  it("generates a different password every time", () => {
    const seen = new Set(Array.from({ length: 25 }, () => generateBootstrapPassword()));
    expect(seen.size).toBe(25);
  });

  it("warns loudly on known-weak passwords, whatever the casing", () => {
    for (const weak of ["changeme123", "ChangeMe123", "password", "admin", "letmein"]) {
      const resolved = resolveBootstrapPassword(weak);
      expect(resolved.generated).toBe(false);
      expect(resolved.warning).toContain("well-known default");
    }
  });

  it("warns on a short password but still honours the operator's choice", () => {
    const resolved = resolveBootstrapPassword("short1");
    expect(resolved.password).toBe("short1");
    expect(resolved.warning).toContain(String(MIN_BOOTSTRAP_PASSWORD_LENGTH));
  });

  it("accepts a strong supplied password without complaint", () => {
    const strong = "correct-horse-battery-staple-42";
    const resolved = resolveBootstrapPassword(strong);
    expect(resolved).toEqual({ password: strong, generated: false });
  });
});
