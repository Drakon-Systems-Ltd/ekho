// Inbound message verification — the agent independently decides whether to trust
// a message, rather than trusting the relay's attribution. Mirrors the Python
// plugin's ekho.verify byte-for-byte (operator key pinned; peer key must be
// operator-endorsed). Same 7 binding checks.

import { agentKeyEndorsementPayload, fromB64url, sha256Hex, verifyCanonical } from "./identity.js";

export interface SignedMessage {
  message_id?: string;
  sender_kind?: string;
  sender_agent_id?: string;
  body?: { text?: string } & Record<string, unknown>;
  operator_sig?: string | null;
  agent_sig?: string | null;
  key_id?: string | null;
  sig_canonical?: Record<string, unknown> | null;
}

export interface RosterEntryLike {
  agent_id?: string;
  identity_public_key?: string | null;
  key_id?: string | null;
  endorsed_by_key_id?: string | null;
  endorsement_sig?: string | null;
}

export interface VerifyResult {
  verified: boolean;
  kind: "operator" | "peer";
  reason: string | null;
  keyId: string | null;
}

export interface VerifyOpts {
  selfAgentId: string;
  fleetId: string;
  operatorKeys: Record<string, string>;
  rosterByAgent: Record<string, RosterEntryLike>;
  seenNonces: Set<string>;
  now: Date;
  maxSkewSeconds?: number;
}

export function verifyInbound(msg: SignedMessage, opts: VerifyOpts): VerifyResult {
  const isOperator = msg.sender_kind === "operator";
  const kind: "operator" | "peer" = isOperator ? "operator" : "peer";
  const keyIdOf = msg.key_id ?? null;
  const fail = (reason: string): VerifyResult => ({ verified: false, kind, reason, keyId: keyIdOf });

  const canonical = msg.sig_canonical;
  const sig = isOperator ? msg.operator_sig : msg.agent_sig;
  if (!sig || !canonical || !msg.key_id) return fail("unsigned");

  // 1. Resolve the signer's public key (peers must be operator-rooted).
  let signerPub: string;
  if (isOperator) {
    const pub = opts.operatorKeys[msg.key_id];
    if (!pub) return fail("unknown-operator-key");
    signerPub = pub;
  } else {
    const entry = opts.rosterByAgent[msg.sender_agent_id ?? ""];
    if (!entry || !entry.identity_public_key || entry.key_id !== msg.key_id) {
      return fail("unknown-sender-key");
    }
    if (!entry.endorsed_by_key_id || !entry.endorsement_sig) return fail("sender-key-unendorsed");
    const endorserPub = opts.operatorKeys[entry.endorsed_by_key_id];
    if (!endorserPub) return fail("endorser-not-pinned");
    const endorsement = agentKeyEndorsementPayload(
      opts.fleetId,
      msg.sender_agent_id ?? "",
      entry.key_id ?? "",
      entry.identity_public_key
    );
    if (!verifyCanonical(endorsement, entry.endorsement_sig, fromB64url(endorserPub))) {
      return fail("bad-endorsement");
    }
    signerPub = entry.identity_public_key;
  }

  // 2. The signature itself must verify over the canonical payload.
  if (!verifyCanonical(canonical, sig, fromB64url(signerPub))) return fail("bad-signature");

  // 3-7. Bind the signed payload to THIS message.
  const c = canonical as Record<string, unknown>;
  if (c.key_id !== msg.key_id) return fail("key-id-mismatch");
  if (c.fleet_id !== opts.fleetId) return fail("fleet-mismatch");
  if (!isOperator && c.sender_agent_id !== msg.sender_agent_id) return fail("sender-mismatch");

  const recipient = (c.recipient ?? {}) as Record<string, unknown>;
  if (recipient.kind === "agent" && recipient.id !== opts.selfAgentId) return fail("recipient-mismatch");

  const text = typeof msg.body?.text === "string" ? msg.body.text : "";
  if (c.body_sha256 !== sha256Hex(text)) return fail("body-mismatch");

  const sentAt = Date.parse(String(c.sent_at));
  if (Number.isNaN(sentAt)) return fail("bad-timestamp");
  if (Math.abs(opts.now.getTime() - sentAt) > (opts.maxSkewSeconds ?? 300) * 1000) return fail("stale");

  const nonce = c.nonce;
  if (!nonce || opts.seenNonces.has(String(nonce))) return fail("replay");

  return { verified: true, kind, reason: null, keyId: msg.key_id };
}
