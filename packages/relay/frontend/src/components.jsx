import React, { useEffect, useRef, useState } from "react";

/* ---------- settings (persisted to localStorage) ---------- */

const SETTINGS_KEY = "ekho.settings.v1";
const DEFAULT_SETTINGS = { agentColors: {}, typingAnimation: true };

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) || {};
    return {
      agentColors: parsed.agentColors && typeof parsed.agentColors === "object" ? parsed.agentColors : {},
      typingAnimation: parsed.typingAnimation !== false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable — settings stay in-memory for this session */
  }
}

// Resolve an agent's bubble accent colour: operator override wins, else the
// deterministic hash colour derived from the agent id.
export function colorForAgent(agentId, settings) {
  const override = settings?.agentColors?.[agentId];
  return override || colorForId(agentId);
}

export function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/* ---------- formatting helpers ---------- */

export function toneForValue(value) {
  const normalized = String(value || "").toLowerCase();
  if (
    normalized.includes("healthy") ||
    normalized.includes("approved") ||
    normalized.includes("executed") ||
    normalized.includes("resume")
  ) {
    return "ok";
  }
  if (
    normalized.includes("pending") ||
    normalized.includes("degraded") ||
    normalized.includes("high") ||
    normalized.includes("warn") ||
    normalized.includes("busy")
  ) {
    return "warn";
  }
  if (
    normalized.includes("reject") ||
    normalized.includes("quarantine") ||
    normalized.includes("paused") ||
    normalized.includes("cancel") ||
    normalized.includes("deny") ||
    normalized.includes("stale")
  ) {
    return "danger";
  }
  return "";
}

const PALETTE = ["#5eead4", "#7dd3fc", "#a5b4fc", "#f0abfc", "#fda4af", "#fcd34d", "#86efac", "#93c5fd"];

export function colorForId(value) {
  const str = String(value || "");
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

export function initialsFor(value) {
  const str = String(value || "").replace(/^agent[_-]?/i, "").trim();
  if (!str) return "··";
  const parts = str.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return str.slice(0, 2).toUpperCase();
}

export function relativeTime(value) {
  if (!value) return "never";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return String(value);
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(value).toLocaleDateString();
}

export function clockTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ---------- atoms ---------- */

export function Badge({ children, tone }) {
  const resolved = tone || toneForValue(children);
  return <span className={`badge ${resolved ? `badge--${resolved}` : ""}`}>{children}</span>;
}

export function StatusDot({ status, title }) {
  const tone = toneForValue(status) || "ok";
  return <span className={`status-dot status-dot--${tone}`} title={title || status} aria-label={String(status)} />;
}

export function LiveDot({ active }) {
  return <span className={`live-dot ${active ? "live-dot--on" : "live-dot--off"}`} aria-hidden="true" />;
}

export function Avatar({ id, label, size = 36, color: colorProp }) {
  const color = colorProp || colorForId(id || label);
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: `${color}22`, color, borderColor: `${color}44`, fontSize: size * 0.34 }}
      title={label || id}
    >
      {initialsFor(label || id)}
    </span>
  );
}

export function StatusMessage({ tone = "", children }) {
  if (!children) return <div className="status-message" />;
  return <div className={`status-message${tone ? ` status-message--${tone}` : ""}`}>{children}</div>;
}

export function EmptyState({ icon, title, children }) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-state__icon">{icon}</div> : null}
      {title ? <div className="empty-state__title">{title}</div> : null}
      <div className="empty-state__body">{children}</div>
    </div>
  );
}

export function StatChip({ label, value, tone }) {
  return (
    <div className={`stat-chip${tone ? ` stat-chip--${tone}` : ""}`}>
      <span className="stat-chip__value">{value}</span>
      <span className="stat-chip__label">{label}</span>
    </div>
  );
}

export function FilterInput({ label, value, onChange, placeholder = "Filter...", type = "text" }) {
  return (
    <label className="filter-field">
      <span>{label}</span>
      <input type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function FilterSelect({ label, value, onChange, options }) {
  return (
    <label className="filter-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Pagination({ page, total, limit, onPageChange }) {
  if (!total || total <= limit) {
    return null;
  }
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="pagination">
      <button className="button button--ghost button--sm" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
        Prev
      </button>
      <span className="pagination__meta">
        {page} / {totalPages}
      </span>
      <button className="button button--ghost button--sm" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}>
        Next
      </button>
    </div>
  );
}

/* ---------- modal system ---------- */

export function Modal({ title, children, onClose, actions = [] }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>{title}</h2>
          <button className="icon-button modal__close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="modal__body">{children}</div>
        {actions.length > 0 && (
          <div className="modal__footer">
            {actions.map((action, i) => (
              <button
                key={i}
                className={`button ${action.variant ? `button--${action.variant}` : ""}`}
                onClick={action.onClick}
                disabled={action.disabled}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, onConfirm, onCancel, confirmLabel = "Confirm", confirmVariant = "danger" }) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      actions={[
        { label: "Cancel", onClick: onCancel, variant: "ghost" },
        { label: confirmLabel, onClick: onConfirm, variant: confirmVariant },
      ]}
    >
      <p style={{ margin: 0, lineHeight: 1.6 }}>{message}</p>
    </Modal>
  );
}

export function PromptDialog({ title, message, defaultValue = "", onConfirm, onCancel }) {
  const [value, setValue] = useState(defaultValue);
  return (
    <Modal
      title={title}
      onClose={onCancel}
      actions={[
        { label: "Cancel", onClick: onCancel, variant: "ghost" },
        { label: "Confirm", onClick: () => onConfirm(value), disabled: !value.trim() },
      ]}
    >
      <p style={{ margin: "0 0 12px", lineHeight: 1.6 }}>{message}</p>
      <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
    </Modal>
  );
}

export function Skeleton({ width = "100%", height = "16px", count = 1, radius = 10 }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ width, height, borderRadius: radius }} />
      ))}
    </>
  );
}

/* ---------- settings + help panels ---------- */

export function SettingsModal({ agents, settings, onChange, onClose }) {
  const setAgentColor = (agentId, color) => {
    onChange({ ...settings, agentColors: { ...settings.agentColors, [agentId]: color } });
  };
  const resetAgentColor = (agentId) => {
    const next = { ...settings.agentColors };
    delete next[agentId];
    onChange({ ...settings, agentColors: next });
  };
  return (
    <Modal title="Settings" onClose={onClose} actions={[{ label: "Done", onClick: onClose, variant: "primary" }]}>
      <div className="settings">
        <label className="toggle settings__master">
          <input
            type="checkbox"
            checked={settings.typingAnimation}
            onChange={(e) => onChange({ ...settings, typingAnimation: e.target.checked })}
          />
          <span>Typing animation</span>
        </label>
        <p className="settings__hint">
          Shows live “typing…” bubbles and reveals incoming replies character-by-character.
          Off renders messages instantly. Always respects your system’s reduced-motion setting.
        </p>

        <div className="rsection-title">Agent colours</div>
        {agents.length ? (
          <div className="settings__agents">
            {agents.map((agent) => {
              const label = agent.display_name || agent.id;
              const current = colorForAgent(agent.id, settings);
              const overridden = Boolean(settings.agentColors[agent.id]);
              return (
                <div className="settings__agent" key={agent.id}>
                  <Avatar id={agent.id} label={label} size={30} color={current} />
                  <div className="settings__agent-id">
                    <div className="settings__agent-name">{label}</div>
                    <div className="settings__agent-meta mono">{agent.id}</div>
                  </div>
                  <label className="settings__swatch" style={{ borderColor: `${current}55` }}>
                    <input type="color" value={current} onChange={(e) => setAgentColor(agent.id, e.target.value)} />
                    <span style={{ background: current }} />
                  </label>
                  <button
                    className="button button--ghost button--sm"
                    onClick={() => resetAgentColor(agent.id)}
                    disabled={!overridden}
                    title="Reset to default colour"
                  >
                    Reset
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="muted-note">No agents yet. Colours appear here once agents enroll.</div>
        )}
      </div>
    </Modal>
  );
}

export function HelpModal({ onClose }) {
  return (
    <Modal title="Ekho by Drakon Systems — Quick Start" onClose={onClose} actions={[{ label: "Got it", onClick: onClose, variant: "primary" }]}>
      <div className="help">
        <ol className="help__steps">
          <li>
            <strong>Run the relay.</strong> On your own server: clone the repo, set <code>.env</code>
            {" "}(operator session secret, <code>EKHO_BASE_URL</code>), run <code>npm run setup</code> to create
            your fleet + operator login, then start it behind HTTPS (e.g. Tailscale Serve). Open this console at
            {" "}<code>&lt;your-base-url&gt;/ui/</code> and sign in.
          </li>
          <li>
            <strong>Add an agent.</strong> Click <strong>Mint enrollment token</strong> (bottom of the right
            panel). On the agent’s machine, install the Ekho plugin for its runtime (e.g. the OpenClaw
            {" "}<code>ekho-adapter</code> plugin) and configure it with your relay URL, fleet id, and the token.
            The agent connects and appears in the <strong>Agents</strong> list, healthy.
          </li>
          <li>
            <strong>Trust the console.</strong> Open the <strong>Access</strong> tab and turn
            {" "}<strong>Operator-trusted channel</strong> on for an agent. It then recognizes you as its verified
            principal and starts replying to you. Off = it stays quiet. (Risky/destructive actions always require
            approval — trust never means blind obedience.)
          </li>
          <li>
            <strong>Talk to your fleet.</strong> Select a conversation or type in the composer (pick a recipient or
            {" "}<strong>Broadcast — all agents</strong>). Trusted agents reply on their own; you’ll see them
            “typing” then respond.
          </li>
          <li>
            <strong>Stay in control.</strong> Use <strong>Pause / Resume / Quarantine</strong> on any agent, watch
            the event/approval log, and toggle trust off any time. Everything is authenticated and audited.
          </li>
        </ol>
      </div>
    </Modal>
  );
}

/* ---------- chat animation atoms ---------- */

// Reveals `text` character-by-character at a human-readable pace. Total animation
// is clamped so long messages don't crawl: ~40 chars/sec, scaled up to finish
// within ~6s. Honours prefers-reduced-motion by rendering instantly. `onTick`
// lets the parent keep the chat scrolled to the bottom as text grows.
export function Typewriter({ text, onTick, onDone }) {
  const reduced = prefersReducedMotion();
  const [count, setCount] = useState(() => (reduced ? text.length : 0));
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const total = text.length;
    if (reduced || total === 0) {
      setCount(total);
      if (doneRef.current) doneRef.current();
      return undefined;
    }
    const BASE_CPS = 40;
    const MAX_MS = 6000;
    // scale speed up if the base pace would overrun the clamp
    const cps = Math.max(BASE_CPS, total / (MAX_MS / 1000));
    const stepMs = Math.max(12, Math.round(1000 / cps));
    // reveal in small chunks so the interval stays cheap for long messages
    const chunk = Math.max(1, Math.round(total / (MAX_MS / stepMs)));

    setCount(0);
    let shown = 0;
    const timer = window.setInterval(() => {
      shown = Math.min(total, shown + chunk);
      setCount(shown);
      if (onTick) onTick();
      if (shown >= total) {
        window.clearInterval(timer);
        if (doneRef.current) doneRef.current();
      }
    }, stepMs);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const done = count >= text.length;
  return (
    <>
      {text.slice(0, count)}
      {!done && !reduced ? <span className="tw-caret" aria-hidden="true" /> : null}
    </>
  );
}

// Three bouncing dots tinted with the agent's accent colour. Static (no bounce)
// under prefers-reduced-motion or when animation is disabled in Settings.
export function TypingDots({ color, animated = true }) {
  const reduced = prefersReducedMotion();
  const still = reduced || !animated;
  return (
    <span className={`typing-dots${still ? " typing-dots--still" : ""}`} aria-hidden="true">
      <span style={{ background: color }} />
      <span style={{ background: color }} />
      <span style={{ background: color }} />
    </span>
  );
}

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="boot-screen">
          <div className="auth-card">
            <h2>Something went wrong</h2>
            <StatusMessage tone="error">{this.state.error?.message || "Unknown error"}</StatusMessage>
            <button className="button" style={{ marginTop: 16 }} onClick={() => this.setState({ hasError: false, error: null })}>
              Try Again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
