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
 *  if endorsed by an already-pinned key (no relay TOFU). Returns true if changed. */
export function syncPinnedOperatorKeys(
  identity: EkhoIdentity,
  operatorKeys: OperatorKeyEntryLike[],
  fleetId: string | null | undefined
): boolean {
  const pinned: Record<string, string> = { ...identity.pinnedOperatorKeys };
  let changed = false;
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

/** The execution-authority gate. Unchanged relay-attested behavior until a message
 *  is signed; signed → act iff verified; signed-but-invalid → blocked. */
export function shouldAutowake(
  msg: SignedMessage,
  verification: VerifyResult | null | undefined,
  operatorTrusted: boolean,
  peerEnabled: boolean
): boolean {
  const isOperator = msg.sender_kind === "operator";
  const signed = Boolean(isOperator ? msg.operator_sig : msg.agent_sig);
  if (isOperator) {
    if (signed && verification) return Boolean(verification.verified);
    return Boolean(operatorTrusted);
  }
  if (!peerEnabled) return false;
  if (signed && verification) return Boolean(verification.verified);
  return true;
}

/** Sign an outbound peer message so recipients can verify it came from us. */
export function buildSignedSendFields(opts: {
  identity: EkhoIdentity;
  fleetId: string;
  selfAgentId: string;
  recipient: Record<string, unknown>;
  conversationId: string;
  bodyText: string;
  nonce: string;
  sentAt: string;
}): { agent_sig: string; key_id: string; sig_canonical: Record<string, unknown> } {
  const seed = new Uint8Array(Buffer.from(opts.identity.seedHex, "hex"));
  const kid = deriveKeyId(fromB64url(publicKeyB64urlFromSeed(seed)));
  const canonical: Record<string, unknown> = {
    v: 1,
    fleet_id: opts.fleetId,
    sender_agent_id: opts.selfAgentId,
    key_id: kid,
    recipient: opts.recipient,
    conversation_id: opts.conversationId,
    body_sha256: sha256Hex(opts.bodyText),
    sent_at: opts.sentAt,
    nonce: opts.nonce
  };
  return { agent_sig: signCanonical(canonical, seed), key_id: kid, sig_canonical: canonical };
}
