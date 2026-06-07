// Verifiable operator identity — pure crypto core (no I/O).
//
// The operator signs each operator->agent message with a portable Ed25519 key.
// The relay stores and relays the signature verbatim; agents verify it against a
// public key they pinned at enrollment. This module is the shared reference
// implementation: its canonical serialization MUST match the Python (Hermes) and
// browser (console) verifiers byte-for-byte, so a frozen test vector pins it.

/**
 * Deterministic JSON: object keys sorted ascending, no insignificant whitespace.
 * This is the exact byte sequence that gets signed and verified everywhere.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") +
    "}"
  );
}
