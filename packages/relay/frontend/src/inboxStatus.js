// Pure console helper (no React/DOM): the per-agent inbox badge on the Health
// tab (#155 Phase 4-H). It draws the relay's own `inbox.state`; it never
// re-derives a state from raw numbers. A missing or malformed field draws
// nothing or an unknown, never a zero or a guessed time.

const STATES = new Set(["working", "unresponsive_inbox", "floor_wait", "queued", "idle"]);
const NOT_REPORTED_NOTE =
  "This adapter does not report turns, so a long turn cannot be told from a stalled inbox.";

const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

// Whole-unit age, or null when the time is missing, unparseable or in the future.
function age(iso, now) {
  if (typeof iso !== "string" || !iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t > now) return null;
  const s = Math.floor((now - t) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function inboxStatus(agent, now = Date.now()) {
  const inbox = agent && typeof agent === "object" ? agent.inbox : null;
  if (!inbox || typeof inbox !== "object" || !STATES.has(inbox.state)) return null;
  const metrics = agent.metrics && typeof agent.metrics === "object" ? agent.metrics : {};
  const adapterState = typeof metrics.adapter_state === "string" ? metrics.adapter_state : "";
  const reported = adapterState !== "";
  const queued = count(inbox.queued);
  const unacked = count(inbox.delivered_unacked);
  const oldest = age(inbox.oldest_queued_at, now);
  const poll = inbox.last_poll_at ? age(inbox.last_poll_at, now) : null;
  const pollText = !inbox.last_poll_at ? "never polled" : poll ? `last poll ${poll} ago` : "";
  const queueText = queued ? `${queued} queued${oldest ? `, oldest ${oldest}` : ""}` : oldest ? `oldest ${oldest}` : "";
  const unackedText = unacked ? `${unacked} fetched, not acknowledged` : "";
  const join = (...p) => p.filter(Boolean).join(" · ");
  const out = (label, tone, detail, title = "") => ({ label, tone, detail, title });

  switch (inbox.state) {
    case "working": {
      const run = age(metrics.turn_started_at, now);
      return out("working", "neutral", join(run ? `turn ${run}` : "", queued ? `${queued} queued behind` : "", unackedText),
        "The agent reports a turn in progress.");
    }
    case "unresponsive_inbox": {
      const detail = join(queueText, pollText, unackedText);
      if (!reported) return out("not fetching", "warn", detail, NOT_REPORTED_NOTE);
      if (adapterState === "turn_running") return out("turn past deadline", "danger", detail, "The reported turn is past its deadline and work is queued.");
      return out("inbox not fetching", "danger", detail, "Work is queued and the agent has not fetched its inbox recently.");
    }
    case "floor_wait":
      return out("waiting on floor", "neutral", unackedText, "Work is waiting for a conversation floor.");
    case "queued":
      return out(queued ? `${queued} queued` : "queued", "neutral", join(oldest ? `oldest ${oldest}` : "", pollText, unackedText), "");
    default:
      return out("inbox idle", "muted", join(pollText, unackedText), "");
  }
}
