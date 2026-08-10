// Pure trust-state helpers for the Security screen. No React / DOM, so they unit-test
// cleanly and keep the component's render logic declarative.
//
// An agent identity key is "endorsed" by an operator key. That endorsement is only
// meaningful if the endorsing operator key is still ACTIVE — once it's revoked (or
// unknown), the agent's peer-trust chain is broken and it must be re-endorsed under a
// live key. These helpers classify that state so the UI can guide the operator instead
// of silently showing a green tick over a dead chain.

/**
 * Classify an agent identity key's endorsement relative to the operator's keys.
 * @returns {{ state: "unendorsed"|"revoked"|"foreign"|"current",
 *             endorserId: string|null, endorserLabel: string|null, needsAction: boolean }}
 */
export function endorserStatus(agentKey, operatorKeys, currentKeyId) {
  const endorserId = (agentKey && agentKey.endorsed_by_key_id) || null;
  if (!endorserId) {
    return { state: "unendorsed", endorserId: null, endorserLabel: null, needsAction: true };
  }
  const endorser = (operatorKeys || []).find((k) => k.key_id === endorserId);
  const endorserLabel = endorser ? endorser.label || null : null;
  // Unknown key or revoked key → the chain is dead; the agent needs re-endorsing.
  if (!endorser || endorser.revoked_at) {
    return { state: "revoked", endorserId, endorserLabel, needsAction: true };
  }
  if (currentKeyId && endorserId === currentKeyId) {
    return { state: "current", endorserId, endorserLabel, needsAction: false };
  }
  // Endorsed by a different but still-active device key — fine; offer consolidation, not a fix.
  return { state: "foreign", endorserId, endorserLabel, needsAction: false };
}

/** How many agent identity keys are endorsed by (depend on) a given operator key. */
export function dependentsOf(keyId, agentKeys) {
  return (agentKeys || []).filter((ak) => ak.endorsed_by_key_id === keyId).length;
}

/**
 * Fleet-wide trust summary: ok only when every agent is endorsed by an active key.
 * @returns {{ ok: boolean, problems: string[], revoked: number, unendorsed: number, total: number }}
 */
export function trustHealth(operatorKeys, agentKeys, currentKeyId) {
  let revoked = 0;
  let unendorsed = 0;
  for (const ak of agentKeys || []) {
    const { state } = endorserStatus(ak, operatorKeys, currentKeyId);
    if (state === "revoked") revoked += 1;
    else if (state === "unendorsed") unendorsed += 1;
  }
  const problems = [];
  if (revoked) problems.push(`${revoked} agent${revoked > 1 ? "s" : ""} trust a revoked key`);
  if (unendorsed) problems.push(`${unendorsed} agent${unendorsed > 1 ? "s" : ""} not endorsed yet`);
  return { ok: problems.length === 0, problems, revoked, unendorsed, total: (agentKeys || []).length };
}

/**
 * Whether the console's unlocked device key can actually sign endorsements, and
 * why not when it can't (#15).
 *
 * The console holds its Ed25519 key in the browser and will happily sign with it
 * whatever the relay thinks of it — including after the operator has revoked
 * that very key. On 10 Aug 2026 that produced a page still offering "Re-endorse
 * all under this device" whose every press failed for all eight agents, with a
 * failure toast that named the agents rather than the dead key. Endorsements
 * signed by a revoked key are worthless: agents drop revoked keys on their next
 * poll, so the chain they build is dead on arrival.
 *
 * @returns {{ canSign: boolean, revoked: boolean, reason: string|null, recovery: string|null }}
 */
export function deviceKeySigningState(operatorKeys, unlockedKeyId) {
  if (!unlockedKeyId) {
    return {
      canSign: false,
      revoked: false,
      reason: "Unlock your operator identity to sign endorsements.",
      recovery: null,
    };
  }
  const key = (operatorKeys || []).find((k) => k.key_id === unlockedKeyId);
  if (!key) {
    return {
      canSign: false,
      revoked: false,
      reason: `This device's key ${unlockedKeyId} is not known to the relay — it was never registered, or the fleet was reset.`,
      recovery: "Forget this device, then enrol a new key.",
    };
  }
  if (key.revoked_at) {
    return {
      canSign: false,
      revoked: true,
      reason: `This device's key ${unlockedKeyId} is REVOKED — endorsements cannot be signed with it, and any it produced are already ignored by every agent.`,
      recovery: "Forget this device, then enrol a new key, then re-endorse every agent under it.",
    };
  }
  return { canSign: true, revoked: false, reason: null, recovery: null };
}

/** The operator keys the relay still considers live. Zero is the alarm state:
 *  agents that pin nothing verify nothing, and under the default
 *  requireSigned:"warn" they then process messages unauthenticated (#15). */
export function liveOperatorKeys(operatorKeys) {
  return (operatorKeys || []).filter((k) => !k.revoked_at);
}

/**
 * Guard for revoking an operator key (#15). Revoking the console's own device
 * key is the move that broke the fleet, and the UI treated it like any other
 * row. Revoking the LAST live key is worse still and is refused outright.
 *
 * @returns {{ blocked: boolean, selfRevoke: boolean, message: string }}
 */
export function revokeGuard(keyId, operatorKeys, unlockedKeyId, dependents) {
  const live = liveOperatorKeys(operatorKeys);
  const isLastLive = live.length <= 1 && live.some((k) => k.key_id === keyId);
  if (isLastLive) {
    return {
      blocked: true,
      selfRevoke: keyId === unlockedKeyId,
      message:
        `${keyId} is your only live operator key. Revoking it leaves the fleet with no trust root: ` +
        `every agent would stop verifying, and on the default "warn" setting they would then process ` +
        `messages unauthenticated. Enrol a replacement key first, then revoke this one.`,
    };
  }
  if (keyId === unlockedKeyId) {
    return {
      blocked: false,
      selfRevoke: true,
      message:
        `${keyId} is THIS device's key — the one the console signs with.\n\n` +
        `Revoking it means you can no longer endorse anything from this browser: the Re-endorse ` +
        `buttons will stop working until you Forget this device and enrol a new key.` +
        (dependents > 0
          ? `\n\n${dependents} agent${dependents > 1 ? "s" : ""} currently trust it and will need re-endorsing under the new key.`
          : "") +
        `\n\nRevoke this device's own key?`,
    };
  }
  if (dependents > 0) {
    return {
      blocked: false,
      selfRevoke: false,
      message:
        `⚠ ${dependents} agent${dependents > 1 ? "s are" : " is"} endorsed by ${keyId} — it is their trust root.\n\n` +
        `Revoking it now BREAKS their verification until you re-endorse them under another active key. ` +
        `Re-endorse them first (panel ③), then revoke.\n\nRevoke anyway?`,
    };
  }
  return {
    blocked: false,
    selfRevoke: false,
    message: `Revoke operator key ${keyId}? Agents will stop trusting it on their next poll.`,
  };
}

/**
 * The key that should endorse a newly generated operator key (#13), or null when
 * there is none. Endorsement is what lets agents adopt a new operator key without
 * trust-on-first-use or hand-edited trust files — the relay verifies and stores it,
 * and agents chain-adopt on their next poll. A revoked endorser is useless (the
 * relay rejects it, and agents drop revoked keys), so only a live one qualifies.
 */
export function pickEndorser(unlocked, operatorKeys) {
  if (!unlocked?.keyId) return null;
  const live = liveOperatorKeys(operatorKeys).some((k) => k.key_id === unlocked.keyId);
  return live ? unlocked : null;
}
