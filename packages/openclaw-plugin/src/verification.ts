// Agent-side verification wiring (mirrors the Python plugin's verification.py):
// pin sync (endorsement-chained, no relay TOFU), per-message verdicts, the
// graceful execution-authority gate, and outbound signing.

import {
  endorsementPayload,
  fromB64url,
  keyId as deriveKeyId,
  publicKeyB64urlFromSeed,
  sha256Hex,
  signCanonical,
  verifyCanonical
} from "./identity.js";
import { verifyInbound, type RosterEntryLike, type SignedMessage, type VerifyResult } from "./verify.js";
import type { EkhoIdentity } from "./credentials.js";

export interface OperatorKeyEntryLike {
  key_id?: string;
  public_key?: string;
  revoked?: boolean;
  endorsed_by_key_id?: string | null;
  endorsement_sig?: string | null;
}

/** Update pinned operator keys from the inbox. Drops revoked; adds a new key ONLY
 *  if endorsed by an already-pinned key. Returns true if changed.
 *
 *  One deliberate exception to "no relay TOFU" (#5): an identity that has never
 *  pinned ANY key can't grow a chain — endorsements need an already-pinned root,
 *  so verification stayed dormant forever on every agent nobody hand-configured
 *  (the Aug 2026 silent-drop incident). First contact with an empty pin set
 *  adopts the relay's current non-revoked keys as the trust root, exactly once
 *  (tofuAt latches). Enrollment already trusts the relay this much — it accepts
 *  the shared secret over the same channel. Pre-pinning via config/env skips
 *  TOFU entirely and stays the stronger option. */
export function syncPinnedOperatorKeys(
  identity: EkhoIdentity,
  operatorKeys: OperatorKeyEntryLike[],
  fleetId: string | null | undefined
): boolean {
  const pinned: Record<string, string> = { ...identity.pinnedOperatorKeys };
  let changed = false;
  if (Object.keys(pinned).length === 0 && !identity.tofuAt) {
    for (const k of operatorKeys) {
      if (k.key_id && k.public_key && !k.revoked) {
        pinned[k.key_id] = k.public_key;
        changed = true;
      }
    }
    if (changed) {
      // Latch only when something was adopted — an empty roster now must not
      // burn the one TOFU opportunity of a fresh identity.
      identity.tofuAt = new Date().toISOString();
      identity.pinnedOperatorKeys = pinned;
      return true;
    }
  }
  for (const k of operatorKeys) {
    const kid = k.key_id;
    if (!kid) continue;
    if (k.revoked) {
      if (pinned[kid]) {
        delete pinned[kid];
        changed = true;
      }
      continue;
    }
    if (pinned[kid]) continue;
    const endorser = k.endorsed_by_key_id;
    const esig = k.endorsement_sig;
    const pub = k.public_key;
    if (endorser && esig && pub && fleetId && pinned[endorser]) {
      if (verifyCanonical(endorsementPayload(fleetId, kid, pub), esig, fromB64url(pinned[endorser]))) {
        pinned[kid] = pub;
        changed = true;
      }
    }
  }
  if (changed) identity.pinnedOperatorKeys = pinned;
  return changed;
}

export function verifyBatch(
  messages: SignedMessage[],
  opts: {
    identity: EkhoIdentity;
    selfAgentId: string;
    fleetId: string | null | undefined;
    roster: RosterEntryLike[];
    seenNonces: Set<string>;
    now: Date;
  }
): Record<string, VerifyResult | null> {
  const operatorKeys = { ...(opts.identity.pinnedOperatorKeys ?? {}) };
  const out: Record<string, VerifyResult | null> = {};
  if (Object.keys(operatorKeys).length === 0 || !opts.fleetId) {
    for (const m of messages) out[String(m.message_id)] = null;
    return out;
  }
  const rosterByAgent: Record<string, RosterEntryLike> = {};
  for (const r of opts.roster) if (r.agent_id) rosterByAgent[String(r.agent_id)] = r;
  for (const m of messages) {
    out[String(m.message_id)] = verifyInbound(m, {
      selfAgentId: opts.selfAgentId,
      fleetId: opts.fleetId,
      operatorKeys,
      rosterByAgent,
      seenNonces: opts.seenNonces,
      now: opts.now
    });
  }
  return out;
}

/** How strictly peer messages must prove themselves before waking a turn (#5).
 *  - "warn" (default): unsigned/unverifiable peers still wake, but are rendered
 *    untrusted — the graceful relay-attested fallback, named for what it is.
 *  - "require": a peer message wakes ONLY when signed and verified; anything
 *    else is dead-lettered by the tick. Operator messages keep the explicit
 *    relay-attested operator_trusted toggle as their unsigned fallback — that
 *    flag is operator-set, not relay-implied, so "require" doesn't cut the
 *    operator off on consoles that don't sign yet.
 *  - "off": same wake behavior as "warn" (kept distinct for config clarity). */
export type RequireSignedMode = "off" | "warn" | "require";

export function parseRequireSignedMode(raw: string | undefined | null): RequireSignedMode {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "require" || v === "off" ? v : "warn";
}

/** The execution-authority gate. Signed → act iff verified; signed-but-invalid →
 *  blocked; unsigned → per requireSigned mode (see above). */
export function shouldAutowake(
  msg: SignedMessage,
  verification: VerifyResult | null | undefined,
  operatorTrusted: boolean,
  peerEnabled: boolean,
  requireSigned: RequireSignedMode = "warn"
): boolean {
  const isOperator = msg.sender_kind === "operator";
  const signed = Boolean(isOperator ? msg.operator_sig : msg.agent_sig);
  if (isOperator) {
    if (signed && verification) return Boolean(verification.verified);
    return Boolean(operatorTrusted);
  }
  if (!peerEnabled) return false;
  if (requireSigned === "require") {
    // Fail closed: signed AND verified, nothing less. A null verification
    // (no pinned keys yet) is exactly the dormant state this mode refuses
    // to treat as trustworthy.
    return Boolean(signed && verification && verification.verified);
  }
  if (signed && verification) return Boolean(verification.verified);
  return true;
}

/** Sign an outbound peer message so recipients can verify it came from us.
 *
 *  v2 (#9) extends coverage to message_type, priority and the attachment ids —
 *  previously a compromised relay could relabel a message (direct → alert) or
 *  swap its attachments under a still-valid signature. Compatibility is free in
 *  both directions: verifiers check the signature over the WHOLE canonical and
 *  only bind the fields they know, so old verifiers accept v2 envelopes and new
 *  verifiers enforce the extra bindings only when the envelope declares v>=2. */
export function buildSignedSendFields(opts: {
  identity: EkhoIdentity;
  fleetId: string;
  selfAgentId: string;
  recipient: Record<string, unknown>;
  conversationId: string;
  bodyText: string;
  nonce: string;
  sentAt: string;
  messageType: string;
  priority: string;
  attachments?: string[];
}): { agent_sig: string; key_id: string; sig_canonical: Record<string, unknown> } {
  const seed = new Uint8Array(Buffer.from(opts.identity.seedHex, "hex"));
  const kid = deriveKeyId(fromB64url(publicKeyB64urlFromSeed(seed)));
  const canonical: Record<string, unknown> = {
    v: 2,
    fleet_id: opts.fleetId,
    sender_agent_id: opts.selfAgentId,
    key_id: kid,
    recipient: opts.recipient,
    conversation_id: opts.conversationId,
    body_sha256: sha256Hex(opts.bodyText),
    sent_at: opts.sentAt,
    nonce: opts.nonce,
    message_type: opts.messageType,
    priority: opts.priority,
    attachments: [...(opts.attachments ?? [])].sort()
  };
  return { agent_sig: signCanonical(canonical, seed), key_id: kid, sig_canonical: canonical };
}
