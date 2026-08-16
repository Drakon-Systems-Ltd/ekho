import { EKHO_ORIGIN_STAMP } from "./autoreply.js";

/**
 * Origin stamping for outbound sends (ekho#17).
 *
 * An Ekho agent identity is per-box: every session on this host signs with the
 * same key. After #32 the relay returns sender metadata verbatim on GET /v1/sent,
 * so a sibling session can only tell "I said that" from "someone else has my key"
 * if the send carries the session that produced it.
 *
 * The rule is honesty over completeness: we stamp only a session identity the
 * host actually handed us. A missing stamp says "this host does not expose a
 * session"; a minted one would say "a different session sent this" on every
 * message. So nothing is invented here — no uuid, no pid, no fallback.
 */

/**
 * The session slice of OpenClaw's `OpenClawPluginToolContext`, feature-detected
 * rather than imported: hosts that predate these fields (or omit them for a
 * given run) simply yield `undefined`.
 */
export interface OriginToolContext {
  sessionKey?: unknown;
  sessionId?: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Pick the session identity to stamp, preferring `sessionKey`.
 *
 * `sessionKey` is the stable conversation identity; `sessionId` is an ephemeral
 * UUID the host regenerates on /new and /reset (openclaw 2026.7.1-2 documents it
 * exactly that way on OpenClawPluginToolContext). Stamping the ephemeral one
 * would make one continuous session look like several, so it is only the
 * fallback for a host that exposes it and not the key.
 *
 * Returns `undefined` when neither is a non-empty string — never throws.
 */
export function resolveOriginSessionId(toolContext?: OriginToolContext | null): string | undefined {
  if (!toolContext || typeof toolContext !== "object") return undefined;
  return nonEmptyString(toolContext.sessionKey) ?? nonEmptyString(toolContext.sessionId);
}

/**
 * Metadata for an outbound send: always the origin stamp peers' auto-reply loops
 * key off, plus `origin_session_id` when — and only when — the host supplied a
 * session identity.
 */
export function buildSendMetadata(originSessionId?: string): Record<string, string> {
  const sessionId = nonEmptyString(originSessionId);
  return {
    ekho_origin: EKHO_ORIGIN_STAMP,
    ...(sessionId ? { origin_session_id: sessionId } : {})
  };
}
