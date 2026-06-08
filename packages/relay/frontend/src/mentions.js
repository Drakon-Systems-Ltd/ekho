// Pure @-mention helpers for the composer. No React/DOM so they unit-test cleanly
// and keep the composer's event handlers declarative.
//
// A "mention token" is an @ that starts a word (preceded by start-of-text or
// whitespace) followed by handle characters. Typing inside one opens the agent
// autocomplete; selecting an agent rewrites the token to its full @handle; on
// send the text is re-parsed into agent ids (text is the source of truth, so
// edits never desync a separately-tracked list).

const HANDLE_CHARS = /[\w-]/;

/**
 * Inspect the caret position for an active @-mention token.
 * @returns {{ active: boolean, query: string, start: number }}
 */
export function mentionContext(text, caret) {
  let i = caret - 1;
  while (i >= 0 && HANDLE_CHARS.test(text[i])) i -= 1;
  // i now points at the char before the run of handle chars.
  if (i < 0 || text[i] !== "@") return { active: false, query: "", start: -1 };
  // The @ must start a word (begin the string or follow whitespace) — so it
  // doesn't fire inside emails like me@host.
  const before = i === 0 ? "" : text[i - 1];
  if (before && !/\s/.test(before)) return { active: false, query: "", start: -1 };
  return { active: true, query: text.slice(i + 1, caret), start: i };
}

/**
 * Replace the active @-token at the caret with the agent's full @handle plus a
 * trailing space. Returns the new text and caret position.
 */
export function insertMention(text, caret, name) {
  const ctx = mentionContext(text, caret);
  if (!ctx.active) return { text, caret };
  const handle = `@${name} `;
  const next = text.slice(0, ctx.start) + handle + text.slice(caret);
  return { text: next, caret: ctx.start + handle.length };
}

/**
 * Resolve every @handle in the text to an agent id, matching display names
 * case-insensitively. De-duped, unknown handles dropped.
 */
export function parseMentions(text, agents) {
  const byName = new Map((agents || []).map((a) => [String(a.display_name || "").toLowerCase(), a.agent_id]));
  const ids = [];
  const seen = new Set();
  const re = /(^|\s)@([\w-]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = byName.get(m[2].toLowerCase());
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** Agents whose display name contains the query (case-insensitive), capped. */
export function filterAgents(agents, query, limit = 6) {
  const q = String(query || "").toLowerCase();
  const matches = (agents || []).filter((a) => String(a.display_name || "").toLowerCase().includes(q));
  return matches.slice(0, limit);
}
