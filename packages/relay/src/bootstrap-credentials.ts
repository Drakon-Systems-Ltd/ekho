// Bootstrap operator credentials for `npm run setup`.
//
// The wizard used to fall back to a hardcoded `changeme123` when
// EKHO_BOOTSTRAP_PASSWORD was unset — and never printed or flagged it. A user
// following the quickstart therefore ended up with an operator account whose
// password is written in the public repo, with nothing on screen to suggest
// anything was wrong. That is a default-credential hole guarding the whole
// control plane, and it sat oddly beside the session secret, which the relay
// refuses to start without.
//
// Now: no supplied password means a strong random one is generated and shown
// once, and a weak supplied password is called out loudly rather than accepted
// in silence.
//
// This lives apart from setup.ts deliberately: setup.ts runs the wizard at
// import time, so a test importing it would execute a real bootstrap.

import crypto from "node:crypto";

/** Passwords we refuse to accept quietly — the old default and its neighbours. */
const KNOWN_WEAK = new Set([
  "changeme123",
  "changeme",
  "change-me",
  "password",
  "password123",
  "admin",
  "admin123",
  "ekho",
  "letmein",
  "secret"
]);

/** Below this, a human-chosen password isn't worth the scrypt protecting it. */
export const MIN_BOOTSTRAP_PASSWORD_LENGTH = 12;

export interface BootstrapPassword {
  password: string;
  /** True when we generated it — the caller must display it exactly once. */
  generated: boolean;
  /** Set when a supplied password is weak; the caller should warn. */
  warning?: string;
}

/**
 * A URL-safe, high-entropy password. 24 base64url chars ≈ 143 bits — long
 * enough that the throttle and scrypt never have to carry the weight.
 */
export function generateBootstrapPassword(): string {
  return crypto.randomBytes(18).toString("base64url");
}

/**
 * Decide the bootstrap operator password. Pure apart from the CSPRNG, so the
 * policy is unit-testable without running the wizard.
 */
export function resolveBootstrapPassword(supplied: string | undefined): BootstrapPassword {
  const value = (supplied ?? "").trim();

  if (!value) {
    return { password: generateBootstrapPassword(), generated: true };
  }
  if (KNOWN_WEAK.has(value.toLowerCase())) {
    return {
      password: value,
      generated: false,
      warning: "that is a well-known default password — change it before exposing the console"
    };
  }
  if (value.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) {
    return {
      password: value,
      generated: false,
      warning: `shorter than ${MIN_BOOTSTRAP_PASSWORD_LENGTH} characters — consider a longer one`
    };
  }
  return { password: value, generated: false };
}
