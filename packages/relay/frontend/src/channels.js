// Client mirror of the relay's canonical channel ids (packages/relay/src/db.ts:
// canonicalDmId + getFleetOverview channel_key). Keep the two in lockstep.

/**
 * The canonical per-agent DM conversation id — a pure function of the agent, so
 * a DM row's label and the conversation it opens can never diverge. Replaces the
 * stale localStorage guess (ekho.dmconv.v1) that produced the "Friday · No
 * messages yet → Friday + Jarvis" mismatch. After the relay's Phase 1 change this
 * is a REAL conversation id whose read merges the agent's full 1:1 history.
 */
export function dmChannelKey(fleetId, agentId) {
  return `dm-${fleetId}-${agentId}`;
}

/**
 * Collapse the relay's per-conversation rows into one row per CHANNEL — one DM
 * per agent, one per room, one per ad-hoc participant-set (group) — deduped by
 * the relay-provided channel_key, newest conversation winning the row. Feeds are
 * dropped (they live only in the Feeds tab). Each row carries:
 *   - channelKey: the dedupe identity (also the pin/unread key)
 *   - convId:     what opening the row selects — a DM opens its canonical MERGED
 *                 id (the channel_key itself); a group/room opens its newest
 *                 representative conversation (grp- keys are display-only).
 */
export function groupConversationsByChannel(conversationList) {
  const byKey = new Map();
  for (const c of conversationList || []) {
    if (c.kind === "feed" || String(c.id || "").startsWith("feed-")) continue;
    const key = c.channel_key || c.id;
    const prev = byKey.get(key);
    if (!prev || String(c.ts) > String(prev.ts)) byKey.set(key, c);
  }
  const rows = [];
  for (const [key, c] of byKey) {
    const convId = String(key).startsWith("dm-") ? key : c.id;
    rows.push({ ...c, channelKey: key, convId });
  }
  return rows;
}
