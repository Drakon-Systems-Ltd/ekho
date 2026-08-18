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
 * THE fleet trust root (#19): the live operator key the most agents are
 * endorsed by, or null when no live key has dependents. A revoked key never
 * qualifies however many agents still pin it — that is a dead chain awaiting
 * re-endorsement, not a root. Null is the fresh-fleet / broken-fleet state:
 * there is no device that can meaningfully act yet.
 *
 * On 16 Aug the operator could not answer "which of my devices is the root?"
 * from anything on screen — every device rendered the same page. This is the
 * single source for that answer.
 */
export function trustRootKey(operatorKeys, agentKeys) {
  let best = null;
  let bestDeps = 0;
  for (const k of operatorKeys || []) {
    if (k.revoked_at) continue;
    const deps = dependentsOf(k.key_id, agentKeys);
    if (deps > bestDeps) {
      best = k;
      bestDeps = deps;
    }
  }
  return best;
}

/** Does THIS browser's unlocked key anchor the fleet's trust? (#19) */
export function thisBrowserHoldsTrustRoot(unlockedKeyId, operatorKeys, agentKeys) {
  if (!unlockedKeyId) return false;
  const root = trustRootKey(operatorKeys, agentKeys);
  return !!root && root.key_id === unlockedKeyId;
}

/**
 * The label of the device that CAN act — endorse, re-endorse, rescue — i.e.
 * the one holding the trust root (#19). Refusal copy uses this to point at a
 * specific device ("Mike iPhone 15 Pro Max") instead of "another device",
 * which told the operator nothing about which browser to walk to. Falls back
 * to the key id when the root was registered without a label; null when no
 * device can act.
 */
export function actingDeviceLabel(operatorKeys, agentKeys) {
  const root = trustRootKey(operatorKeys, agentKeys);
  if (!root) return null;
  return root.label || root.key_id;
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
 * `agentKeys` is optional; when given, the recovery names the device that holds
 * the trust root instead of "another device" (#19).
 *
 * @returns {{ canSign: boolean, revoked: boolean, reason: string|null, recovery: string|null }}
 */
export function deviceKeySigningState(operatorKeys, unlockedKeyId, agentKeys) {
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
      // #19: NOT "forget device and enrol". Enrolling here mints a key this
      // browser can never endorse (no live seed to sign with), and the relay
      // refuses that key id ever after — which is how 16 Aug burnt one and left
      // the operator still locked out. Rescue has to come from a healthy device
      // — named, when we know which one it is.
      recovery: (() => {
        const label = agentKeys ? actingDeviceLabel(operatorKeys, agentKeys) : null;
        return label
          ? `Open the console on “${label}” — the device that holds the fleet trust root — and endorse this device's key from its Security screen.`
          : "Open the console on another device that holds a live key and endorse this device's key from its Security screen.";
      })(),
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
const REVOKE_IS_TERMINAL =
  "This cannot be undone. Recovery is to mint a new device key — Endorse will not restore a revoked key.";

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
        `messages unauthenticated. Enrol a replacement key first, then revoke this one. ` +
        REVOKE_IS_TERMINAL,
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
        `\n\n${REVOKE_IS_TERMINAL}\n\nRevoke this device's own key?`,
    };
  }
  if (dependents > 0) {
    return {
      blocked: false,
      selfRevoke: false,
      message:
        `⚠ ${dependents} agent${dependents > 1 ? "s are" : " is"} endorsed by ${keyId} — it is their trust root.\n\n` +
        `Revoking it now BREAKS their verification until you re-endorse them under another active key. ` +
        `Re-endorse them first (panel ③), then revoke.\n\n${REVOKE_IS_TERMINAL}\n\nRevoke anyway?`,
    };
  }
  return {
    blocked: false,
    selfRevoke: false,
    message: `Revoke operator key ${keyId}? Agents will stop trusting it on their next poll.\n\n${REVOKE_IS_TERMINAL}`,
  };
}

/**
 * The key that should endorse a newly generated operator key (#13), or null when
 * there is none. Endorsement is what lets agents adopt a new operator key without
 * trust-on-first-use or hand-edited trust files — the relay verifies and stores it,
 * and agents chain-adopt on their next poll. A revoked endorser is useless (the
 * relay rejects it, and agents drop revoked keys), so only a live one qualifies.
 */
/**
 * May the key unlocked in this browser endorse ANYTHING — an agent key in panel
 * ③ or another operator key in panel ②?
 *
 * 16 Aug 2026: the answer used to be "yes, if it exists". The operator's laptop
 * held a key that was live on the relay but endorsed by nobody and pinned by no
 * agent, and from it he ran panel ③'s bulk "re-endorse all under this device".
 * All 8 agent keys were re-rooted onto it while every agent still pinned the
 * previous root, so the entire fleet's agent-to-agent traffic began dead-
 * lettering with `endorser-not-pinned`. Endorsing from an untrusted key does not
 * grant trust — it destroys it, by moving keys the fleet DID trust onto a root
 * it does not.
 *
 * "Live" is not "trusted". A key may endorse only if the fleet would actually
 * believe it: it is already a trust root, or it chains to a live one. The
 * bootstrap case (a fresh fleet with no agent keys yet) stays open, or first
 * enrolment could never happen.
 *
 * @returns {{ allowed: boolean, reason: string|null }}
 */
export function endorseAuthority(unlockedKeyId, operatorKeys, agentKeys) {
  if (!unlockedKeyId) return { allowed: false, reason: "Unlock this device's operator identity first." };
  const keys = operatorKeys || [];
  const mine = keys.find((k) => k.key_id === unlockedKeyId);
  if (!mine) {
    return { allowed: false, reason: `This device's key ${unlockedKeyId} is not registered with the relay.` };
  }
  if (mine.revoked_at) {
    // Points at the device that CAN do it — by name when a root exists. Never
    // "Forget device" — that advice burnt a key id on 16 Aug and left the
    // operator just as locked out.
    const label = actingDeviceLabel(keys, agentKeys);
    return {
      allowed: false,
      reason:
        `This device's key ${unlockedKeyId} is revoked and cannot endorse anything. ` +
        (label
          ? `Do it from “${label}” — the device that holds the fleet trust root.`
          : `Do it from another device that holds a live key.`),
    };
  }
  // Already a trust root: agents verify against it today, so endorsing from it
  // keeps them where they are.
  if (dependentsOf(unlockedKeyId, agentKeys) > 0) return { allowed: true, reason: null };
  // Chains to a live key, so agents adopt it by themselves (#13).
  const endorser = mine.endorsed_by_key_id
    ? keys.find((k) => k.key_id === mine.endorsed_by_key_id && !k.revoked_at)
    : undefined;
  if (endorser) return { allowed: true, reason: null };
  // Nothing is pinned to anything yet, so there is no trust to destroy. This is
  // "no agent is endorsed", not "no agent exists": an enrolled agent whose key
  // has never been endorsed is still the fresh-fleet case, and testing for an
  // empty list would strand a fleet the moment its first agent enrolled.
  if (!agentKeys || agentKeys.every((k) => !k.endorsed_by_key_id)) return { allowed: true, reason: null };
  const label = actingDeviceLabel(keys, agentKeys);
  return {
    allowed: false,
    reason:
      `This device's key ${unlockedKeyId} is live but unendorsed, and no agent trusts it. ` +
      `Endorsing from here would move your agents onto a key none of them pin and stop the fleet talking to itself. ` +
      (label
        ? `Do it from “${label}” — the device that holds the fleet trust root — or have that device endorse this one first.`
        : `Do it from a device that holds a trusted key, or have that device endorse this one first.`),
  };
}

/**
 * Live operator keys carrying no endorsement (#19) — excluding the trust root
 * itself, which is what everything else chains to.
 *
 * An unendorsed key is invisible to the fleet: agents adopt an operator key by
 * chaining from one they already trust, so a key with `endorsed_by_key_id: null`
 * gets `unknown-operator-key` from every recipient no matter how live the relay
 * considers it. The device that minted it cannot repair it — the console signs
 * an endorsement only with the key in its own browser, and on a stranded device
 * that key is the revoked one. So the list has to surface HERE, on whichever
 * device is healthy, or the orphan is unrescuable.
 */
export function orphanedOperatorKeys(operatorKeys, rootKeyId) {
  if (!operatorKeys || !rootKeyId) return [];
  return operatorKeys.filter(
    (k) => !k.revoked_at && !k.endorsed_by_key_id && k.key_id !== rootKeyId
  );
}

/**
 * Can the key unlocked in THIS browser endorse `targetKeyId` (#19)?
 *
 * @returns {{ allowed: boolean, reason: string|null }}
 */
export function rescueGuard(targetKeyId, operatorKeys, unlockedKeyId, agentKeys = []) {
  if (targetKeyId && targetKeyId === unlockedKeyId) {
    return { allowed: false, reason: "A key cannot endorse itself — use the device that holds a different live key." };
  }
  // The signer must be one the fleet actually believes. On 16 Aug a live-but-
  // untrusted key was allowed to endorse and took the whole fleet's peer traffic
  // down with it; "revoked or unregistered" was never a strict enough test.
  const authority = endorseAuthority(unlockedKeyId, operatorKeys, agentKeys);
  if (!authority.allowed) return authority;
  const keys = operatorKeys || [];
  const target = keys.find((k) => k.key_id === targetKeyId);
  if (!target) return { allowed: false, reason: `Unknown key ${targetKeyId}.` };
  if (target.revoked_at) return { allowed: false, reason: `${targetKeyId} is revoked — endorsing it would achieve nothing.` };
  return { allowed: true, reason: null };
}

export function pickEndorser(unlocked, operatorKeys) {
  if (!unlocked?.keyId) return null;
  const live = liveOperatorKeys(operatorKeys).some((k) => k.key_id === unlocked.keyId);
  return live ? unlocked : null;
}

/**
 * May THIS browser mint a brand-new operator identity (#19 follow-up)?
 *
 * 16 Aug burnt a key when Generate identity ran on a stranded browser that held
 * only a revoked seed: the new id registered, could never be endorsed from that
 * same browser, and the relay refused the id forever after. The console then
 * refused Generate whenever `pickEndorser(getUnlocked())` was null.
 *
 * That over-corrected. A phone with **no local key at all** (empty browser,
 * fresh device, post-Forget) is not stranded — it is the normal second-device
 * enrolment path. The live trust root sits on another browser; after Generate
 * registers the new public key, that root endorses it in panel ②. Blocking
 * mint here leaves the operator staring at a red "could never be endorsed"
 * wall while the laptop is already SIGNING as the root.
 *
 * Refuse only when this browser still holds a seed that cannot act as endorser
 * (revoked / unknown). Empty + a live root elsewhere = allow, with copy that
 * says the next step is Endorse from the root device.
 *
 * @returns {{ allowed: boolean, reason: string|null, nextStep: string|null }}
 */
export function mayGenerateNewOperatorIdentity(unlocked, operatorKeys, agentKeys = []) {
  const keys = operatorKeys || [];
  const live = liveOperatorKeys(keys);
  // First enrolment / fully dead fleet: mint is the only way back.
  if (live.length === 0) {
    return { allowed: true, reason: null, nextStep: null };
  }
  // This browser already holds a live key — Generate would replace it and should
  // chain-endorse from that seed (existing pickEndorser path).
  if (pickEndorser(unlocked, keys)) {
    return { allowed: true, reason: null, nextStep: null };
  }
  // Empty browser (not unlocked, nothing stored to unlock): second-device enrol.
  // A live root exists elsewhere and can Endorse the new key after registration.
  if (!unlocked?.keyId) {
    const label = actingDeviceLabel(keys, agentKeys);
    return {
      allowed: true,
      reason: null,
      nextStep: label
        ? `After Generate, open the console on “${label}” (fleet trust root) and press Endorse on this new key in panel ②.`
        : "After Generate, open the console on a device that holds a live key and press Endorse on this new key in panel ②.",
    };
  }
  // Unlocked but not a live endorser (revoked / unknown seed still in the store).
  const label = actingDeviceLabel(keys, agentKeys);
  return {
    allowed: false,
    reason:
      "This browser still holds a key that cannot endorse anything. " +
      "Forget device first to clear it, then Generate a fresh identity — " +
      "or unlock a live key on another device and Endorse from there.",
    nextStep: label
      ? `Live trust root is on “${label}”.`
      : "Use a device that still holds a live operator key.",
  };
}
