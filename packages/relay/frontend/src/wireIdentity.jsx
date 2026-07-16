// The Wire cast system: every agent gets a stable color + geometric glyph so the
// fleet reads like a cast of characters across the chat list, bubbles, typing
// indicators, presence dots, health board and topology. Known agents get
// hand-tuned glyphs/hues (via .c-<slug> classes in wire.css, re-tuned per theme);
// unknown/future agents get a deterministic hash hue + fallback glyph so the
// system degrades gracefully as the fleet grows. Glyphs are real JSX — the
// console keeps its zero-innerHTML invariant.
import React from "react";

const CAST_GLYPHS = {
  jarvis: <><path d="M6.5 13.2l5.5-4.6 5.5 4.6M6.5 18.4l5.5-4.6 5.5 4.6" /></>,
  friday: <><circle cx="11" cy="13" r="5.6" /><circle className="f" cx="17.6" cy="6.4" r="2.1" /></>,
  case: <><path d="M9.4 6.5L5 12l4.4 5.5M14.6 6.5L19 12l-4.4 5.5" /></>,
  edith: <><circle cx="7.6" cy="12.4" r="3.4" /><circle cx="16.4" cy="12.4" r="3.4" /><path d="M11 12.4h2M4.2 12l-1.4-1.4M19.8 12l1.4-1.4" /></>,
  vision: <><path d="M12 4.4l6.2 7.6-6.2 7.6-6.2-7.6z" /><circle className="f" cx="12" cy="12" r="1.9" /></>,
  tars: <><path d="M8.4 4.5h7.2v15H8.4z" /><path d="M8.4 9.5h7.2M8.4 14.5h7.2" /></>,
  athena: <><path d="M12 4.2l6.8 2.9v4.6c0 3.9-2.8 6.4-6.8 8.1-4-1.7-6.8-4.2-6.8-8.1V7.1z" /><path d="M12 8.5v5" /></>,
};

const OPERATOR_GLYPH = <><circle cx="12" cy="12" r="7" /><circle className="f" cx="12" cy="12" r="2.4" /></>;

// Fallback glyphs for agents that join the fleet later — assigned by name hash.
const FALLBACK_GLYPHS = [
  <><circle cx="12" cy="12" r="6.5" /><path d="M12 5.5v13" /></>,
  <><path d="M5 12h14M12 5v14" /><circle cx="12" cy="12" r="3.2" /></>,
  <><path d="M12 4.5l6.5 11.3H5.5z" /></>,
  <><rect x="6" y="6" width="12" height="12" rx="2.5" /><path d="M6 12h12" /></>,
  <><path d="M6 8c4-4 8 4 12 0M6 16c4-4 8 4 12 0" /></>,
  <><circle cx="8.5" cy="12" r="4" /><circle cx="15.5" cy="12" r="4" /></>,
];

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Slug for the hand-tuned cast, or null for unknown agents. */
export function castSlug(displayName) {
  const s = String(displayName || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CAST_GLYPHS, s) ? s : null;
}

/** Glyph JSX for any agent — cast glyph or deterministic fallback. */
export function glyphFor(displayName, isOperator = false) {
  if (isOperator) return OPERATOR_GLYPH;
  const slug = castSlug(displayName);
  if (slug) return CAST_GLYPHS[slug];
  return FALLBACK_GLYPHS[hashCode(displayName) % FALLBACK_GLYPHS.length];
}

/** Fallback hue for non-cast agents; the cast gets theirs from wire.css. */
export function fallbackHue(displayName) {
  const h = hashCode(displayName) % 360;
  return `oklch(0.62 0.14 ${h})`;
}

/** Presence for the avatar dot: "online" | "slow" | "away" | "off". */
export function presenceOf(agent, nowMs = Date.now()) {
  if (!agent) return "off";
  if (agent.status === "paused" || agent.status === "quarantined") return "off";
  const health = agent.health?.level || null;
  if (health === "degraded" || health === "down" || agent.status === "degraded") return "slow";
  const seen = agent.last_seen_at ? new Date(agent.last_seen_at).getTime() : 0;
  if (!Number.isFinite(seen) || nowMs - seen > 120_000) return "away";
  return "online";
}

/**
 * The avatar. Size in px; presence dot optional ("online" green, "slow" amber,
 * "away"/"off" grey, null = no dot). Identity color comes from the .c-<slug>
 * class (theme-tuned) or an inline --ag fallback for unknown agents.
 */
export function WireAvatar({ name, presence = null, size = 40, className = "", operator = false, hue = null }) {
  // An explicit hue (the operator's per-agent colour override) beats the cast.
  const slug = operator ? "op" : hue ? null : castSlug(name);
  const style = { width: size, height: size };
  if (!slug) style["--ag"] = hue || fallbackHue(name);
  const dotClass = presence === "slow" ? "dot slow" : presence === "online" ? "dot" : presence ? "dot off" : null;
  return (
    <span
      className={`av${slug ? ` c-${slug}` : ""}${className ? ` ${className}` : ""}`}
      style={style}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24">{glyphFor(name, operator)}</svg>
      {dotClass ? <span className={dotClass} /> : null}
    </span>
  );
}

/** Stacked two-member avatar for rooms. */
export function RoomAvatar({ members = [], size = 46 }) {
  const a = members[0] || "?";
  const b = members[1] || a;
  return (
    <span className="roomav" style={{ width: size, height: size }} aria-hidden="true">
      <WireAvatar name={a} size={Math.round(size * 0.65)} />
      <WireAvatar name={b} size={Math.round(size * 0.65)} />
    </span>
  );
}

/** Non-agent chat marks: broadcast megaphone + feed newspaper. */
export function ChannelMark({ kind, size = 46 }) {
  return (
    <span className={`av mark-${kind}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24">
        {kind === "feed" ? (
          <>
            <path d="M5 6h11v12.5H6.5A1.5 1.5 0 0 1 5 17z" />
            <path d="M16 9h3v8a1.5 1.5 0 0 1-1.5 1.5H16z" />
            <path d="M7.5 9h6M7.5 12h6M7.5 15h4" />
          </>
        ) : (
          <>
            <path d="M4 10v4h3l6 4V6l-6 4H4z" />
            <path d="M17 9a4 4 0 0 1 0 6" />
            <path d="M19.4 6.6a7.5 7.5 0 0 1 0 10.8" />
          </>
        )}
      </svg>
    </span>
  );
}

/** Delivery tick SVGs: sent (one), delivered (two), read (two, green). */
export function Tick({ status }) {
  if (status === "read") {
    return (
      <svg className="read" viewBox="0 0 16 12" aria-label="read">
        <path d="M1 6.5l3.5 3.5L11 3.5" /><path d="M7 8.5l1.5 1.5L15 3.5" />
      </svg>
    );
  }
  if (status === "delivered") {
    return (
      <svg viewBox="0 0 16 12" aria-label="delivered">
        <path d="M1 6.5l3.5 3.5L11 3.5" /><path d="M7 8.5l1.5 1.5L15 3.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 12" aria-label={status === "pending" ? "sending" : "sent"}>
      <path d="M2 6.5l3.5 3.5L12 3.5" />
    </svg>
  );
}
