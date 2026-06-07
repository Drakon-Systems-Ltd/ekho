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
