// `@drakon-systems/ekho-sdk/identity` — the verifiable-identity layer every
// TypeScript Ekho agent shares: Ed25519 primitives with the frozen canonical
// form, the identity file (atomic save, refuse-to-mint rules), inbound
// verification, operator-key pin sync and outbound signing. Extracted from the
// OpenClaw plugin so the MCP connector signs and verifies with the identical
// code rather than a copy that can drift.
export * from "./primitives.js";
export * from "./verify.js";
export * from "./store.js";
export * from "./verification.js";
