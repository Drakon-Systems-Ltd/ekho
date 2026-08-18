// Agent-side verification wiring (mirrors the Python plugin's verification.py):
// pin sync (endorsement-chained, no relay TOFU), per-message verdicts, the
// graceful execution-authority gate, and outbound signing.

import {
  endorsementPayload,
  fromB64url,
  keyId as deriveKeyId,
  publicKeyB64urlFromSeed,
  revocationPayload,
  sha256Hex,
  signCanonical,
  unrevokePayload,
  verifyCanonical
} from "./identity.js";
import { verifyInbound, type RosterEntryLike, type SignedMessage, type VerifyResult } from "./verify.js";
import type { EkhoIdentity, OperatorKeyAdmission } from "./credentials.js";

export interface OperatorKeyEntryLike {
  key_id?: string;
  public_key?: string;
  revoked?: boolean;
  endorsed_by_key_id?: string | null;
  endorsement_sig?: string | null;
  /** #27: signature over revocationPayload(fleet, key_id, revoked_at) by a
   *  currently pinned operator key. WITHOUT it, `revoked` is advisory only. */
  revocation_sig?: string | null;
  /** #27: the revocation time, inside the signed bytes (so the relay cannot
   *  restate when a key died under a still-valid signature). */
  revoked_at?: string | null;
  /** #27 / #48: signature over unrevokePayload(fleet, key, revoked_at, issued_at, nonce). */
  unrevoke_sig?: string | null;
  unrevoke_revoked_at?: string | null;
  unrevoke_issued_at?: string | null;
  unrevoke_nonce?: string | null;
}

/** Where the sync reports trust-root decisions. Defaults to the console, because
 *  a relay claiming a revocation it can't prove must never pass in silence. */
export interface SyncLog {
  info?: (...a: unknown[]) => void;
  warn?: (...a: unknown[]) => void;
}

/** The working trust root mid-sync, plus what may authorize a change to it. */
interface ClaimCtx {
  operatorKeys: OperatorKeyEntryLike[];
  fleetId: string | null | undefined;
  log: SyncLog;
  pinned: Record<string, string>;
  revokedLedger: Record<string, string>;
  admissions: Record<string, OperatorKeyAdmission>;
  signedByAPinnedKey: (payload: unknown, sig: string) => boolean;
}

interface RelayKeyClaims {
  /** Key ids the relay CLAIMS are revoked without proving it. Blocked from new
   *  adoption this poll; nothing about them is written to disk. */
  advisory: Set<string>;
  pinRemoved: boolean;
  ledgerChanged: boolean;
  admissionsChanged: boolean;
}

/** Apply the relay's revocation / un-revocation claims to the working trust root
 *  (#27). Mutates `pinned`, `revokedLedger` and `admissions` in place; a claim
 *  only lands if a currently pinned operator key signed it. */
function applyRelayKeyClaims(ctx: ClaimCtx): RelayKeyClaims {
  const out: RelayKeyClaims = {
    advisory: new Set<string>(),
    pinRemoved: false,
    ledgerChanged: false,
    admissionsChanged: false
  };
  clearTombstonesOnSignedUnrevoke(ctx, out);
  applySignedRevocations(ctx, out);
  return out;
}

/** A SIGNED un-revoke clears a tombstone so the key can be re-admitted through
 *  the endorsement chain. It never re-pins by itself — re-admission still costs
 *  a valid endorsement. Runs before the revocation pass so a valid revocation in
 *  the same batch still wins (fail closed).
 *
 *  The unsigned ABSENCE of `revoked` must never clear a tombstone: that was the
 *  #14 hole, where a relay could resurrect a dead key just by not mentioning it.
 *
 *  #48: the payload now binds revoked_at_being_cleared + issued_at + nonce.
 *  Missing bind fields refuse the un-revoke (fail closed). The relay still
 *  does not emit unrevoke_sig. */
function clearTombstonesOnSignedUnrevoke(ctx: ClaimCtx, out: RelayKeyClaims): void {
  for (const k of ctx.operatorKeys) {
    const kid = k.key_id;
    const sig = k.unrevoke_sig;
    const revokedAt = k.unrevoke_revoked_at;
    const issuedAt = k.unrevoke_issued_at;
    const nonce = k.unrevoke_nonce;
    if (!kid || !sig || !ctx.revokedLedger[kid]) continue;
    if (!revokedAt || !issuedAt || !nonce) {
      ctx.log?.warn?.(
        `[ekho] refusing un-revoke of operator key ${kid}: payload bind fields missing. ` +
          `The tombstone stands.`
      );
      continue;
    }
    if (!ctx.fleetId || !ctx.signedByAPinnedKey(unrevokePayload(ctx.fleetId, kid, revokedAt, issuedAt, nonce), sig)) {
      ctx.log?.warn?.(
        `[ekho] refusing un-revoke of operator key ${kid}: no currently pinned operator key signed it. ` +
          `The tombstone stands.`
      );
      continue;
    }
    delete ctx.revokedLedger[kid];
    out.ledgerChanged = true;
    ctx.log?.info?.(
      `[ekho] operator key ${kid} un-revoked by a signed operator instruction; tombstone cleared. ` +
        `The key is NOT re-pinned — it has to be re-endorsed by a pinned key.`
    );
  }
}

/** A SIGNED revocation is the only thing that can remove trust. Anything less is
 *  recorded as advisory: the key is skipped for new adoption and nothing else. */
function applySignedRevocations(ctx: ClaimCtx, out: RelayKeyClaims): void {
  for (const k of ctx.operatorKeys) {
    const kid = k.key_id;
    if (!kid || !k.revoked) continue;
    const at = k.revoked_at;
    const sig = k.revocation_sig;
    const proven = Boolean(
      sig && at && ctx.fleetId && ctx.signedByAPinnedKey(revocationPayload(ctx.fleetId, kid, at), sig)
    );
    if (!proven) {
      noteAdvisoryClaim(ctx, out, kid);
    } else if (isLastPinnedKey(ctx, kid)) {
      noteLastRootRefusal(ctx, kid);
    } else {
      dropRevokedKey(ctx, out, kid, at as string);
    }
  }
}

/** The relay says a key is dead but cannot prove it. Skip the key for NEW
 *  adoption, write nothing, say so out loud.
 *
 *  Deleting the pin here is the tempting one-liner and it is wrong twice over:
 *  it lets whoever controls the relay drop trust unilaterally, AND a deleted pin
 *  is re-admitted on the very next poll by the same still-valid endorsement.
 *  Rejecting a key takes a revokedOperatorKeys tombstone, not a deletion — and a
 *  tombstone takes a signature. */
function noteAdvisoryClaim(ctx: ClaimCtx, out: RelayKeyClaims, kid: string): void {
  out.advisory.add(kid);
  ctx.log?.warn?.(
    `[ekho] relay reports operator key ${kid} as REVOKED without a valid revocation signature. ` +
      `Treating the claim as ADVISORY: the key is NOT unpinned and NOT tombstoned, but it will not ` +
      `be newly adopted until a signed revocation arrives.`
  );
}

function isLastPinnedKey(ctx: ClaimCtx, kid: string): boolean {
  return Boolean(ctx.pinned[kid]) && Object.keys(ctx.pinned).length === 1;
}

/** Last-root protection: honoring this would leave the box with no trust root at
 *  all — indistinguishable from the attack the signature requirement just
 *  closed. Refuse the claim whole, so we never hold a key that is tombstoned
 *  (unrecoverable) and still pinned (still trusted). */
function noteLastRootRefusal(ctx: ClaimCtx, kid: string): void {
  ctx.log?.warn?.(
    `[ekho] refusing the signed revocation of operator key ${kid}: it is the LAST pinned operator key, ` +
      `and honoring it would leave this agent with no trust root at all. Endorse a replacement key ` +
      `first — the replacement makes this revocation safe to honor on the next poll.`
  );
}

/** Honor a proven revocation: tombstone, then unpin.
 *
 *  #14: the tombstone is the durable half. Unpinning alone never made a
 *  revocation stick — the config seed re-added the key on the very next wake,
 *  and TOFU/chaining would too. */
function dropRevokedKey(ctx: ClaimCtx, out: RelayKeyClaims, kid: string, at: string): void {
  if (!ctx.revokedLedger[kid]) {
    ctx.revokedLedger[kid] = at;
    out.ledgerChanged = true;
  }
  if (ctx.pinned[kid]) {
    Reflect.deleteProperty(ctx.pinned, kid);
    out.pinRemoved = true;
    ctx.log?.warn?.(`[ekho] operator key ${kid} is revoked (signed, at ${at}); it is no longer pinned.`);
  }
  if (ctx.admissions[kid]) {
    // The admission record answers "why is this key trusted here?" — keep it
    // only while the answer is "it is".
    Reflect.deleteProperty(ctx.admissions, kid);
    out.admissionsChanged = true;
  }
}

/** Update pinned operator keys from the inbox. Adds a new key ONLY if endorsed by
 *  an already-pinned key; removes one ONLY on a SIGNED revocation. Returns true
 *  if the identity changed (and so must be persisted).
 *
 *  Trust mutates in one direction only, and never on the relay's say-so (#27).
 *  An unsigned `revoked: true` is a HINT: the key is skipped for new adoption
 *  and the claim is logged, but nothing is written and nothing is unpinned.
 *  Treating it as authoritative (the #14 regression) meant one poll from a
 *  compromised relay could tombstone and unpin an entire fleet's trust root,
 *  permanently — the tombstone survives restarts by design, so the damage was
 *  not even recoverable by restarting against an honest relay.
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
  fleetId: string | null | undefined,
  log: SyncLog = console
): boolean {
  const pinned: Record<string, string> = { ...identity.pinnedOperatorKeys };
  const revokedLedger: Record<string, string> = { ...(identity.revokedOperatorKeys ?? {}) };
  const admissions: Record<string, OperatorKeyAdmission> = { ...(identity.operatorKeyAdmissions ?? {}) };

  // The keys allowed to authorize a trust-root mutation this poll, snapshotted
  // BEFORE any of them are applied. Frozen on purpose: verifying against the
  // live map would make the outcome depend on the order the relay happened to
  // serve its entries in, which is the relay's choice, not ours.
  const authorities: Record<string, string> = { ...identity.pinnedOperatorKeys };
  const signedByAPinnedKey = (payload: unknown, sig: string): boolean => {
    for (const pub of Object.values(authorities)) {
      if (verifyCanonical(payload, sig, fromB64url(pub))) return true;
    }
    return false;
  };

  // Phases 1 and 2 (#27) — mutates `pinned` / `revokedLedger` / `admissions` in
  // place and reports back what it touched.
  const claims = applyRelayKeyClaims(
    { operatorKeys, fleetId, log, pinned, revokedLedger, admissions, signedByAPinnedKey }
  );
  const advisory = claims.advisory;
  let changed = claims.pinRemoved;
  let admissionsChanged = claims.admissionsChanged;

  if (claims.ledgerChanged) {
    identity.revokedOperatorKeys = revokedLedger;
    changed = true; // must persist, even when the key was never pinned here
  }

  if (Object.keys(pinned).length === 0 && !identity.tofuAt) {
    let adopted = false;
    const at = new Date().toISOString();
    for (const k of operatorKeys) {
      if (k.key_id && k.public_key && !advisory.has(k.key_id) && !revokedLedger[k.key_id]) {
        pinned[k.key_id] = k.public_key;
        admissions[k.key_id] = { admitted_by: "tofu", admitted_at: at }; // #26
        admissionsChanged = true;
        adopted = true;
      }
    }
    if (adopted) {
      // Latch only when something was adopted — an empty roster now must not
      // burn the one TOFU opportunity of a fresh identity. (Tracked separately
      // from `changed`, which a revocation tombstone alone can now set.)
      identity.tofuAt = at;
      identity.pinnedOperatorKeys = pinned;
      identity.operatorKeyAdmissions = admissions;
      return true;
    }
  }
  for (const k of operatorKeys) {
    const kid = k.key_id;
    if (!kid) continue;
    if (pinned[kid]) continue;
    if (revokedLedger[kid]) continue; // #14: a tombstoned key never comes back
    if (advisory.has(kid)) continue; // #27: claimed-revoked → no NEW adoption
    const endorser = k.endorsed_by_key_id;
    const esig = k.endorsement_sig;
    const pub = k.public_key;
    if (endorser && esig && pub && fleetId && pinned[endorser]) {
      if (verifyCanonical(endorsementPayload(fleetId, kid, pub), esig, fromB64url(pinned[endorser]))) {
        pinned[kid] = pub;
        changed = true;
        // #26: keep the endorsement we just verified, so this box can answer
        // "why is this key trusted here?" offline — the relay is exactly the
        // party we would otherwise have to ask.
        admissions[kid] = {
          admitted_by: "chain",
          endorsed_by_key_id: endorser,
          endorsement_sig: esig,
          admitted_at: new Date().toISOString()
        };
        admissionsChanged = true;
      }
    }
  }
  if (changed) identity.pinnedOperatorKeys = pinned;
  if (admissionsChanged) {
    identity.operatorKeyAdmissions = admissions;
    changed = true;
  }
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
