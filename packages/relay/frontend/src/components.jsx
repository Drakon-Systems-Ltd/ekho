import React, { useEffect, useRef, useState } from "react";
import { fetchAttachmentObjectUrl } from "./api";

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

export function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/* ---------- attachment allowlist (mirrors the relay's ATTACHMENT_MIME_ALLOWLIST) ---------- */

// Keep this in lockstep with packages/relay/src/attachments.ts. The server is
// authoritative; these are UX hints (accept attr + friendly pre-flight errors).
export const ATTACHMENT_ALLOWED_MIME = {
  "image/png": { ext: "png", image: true },
  "image/jpeg": { ext: "jpg", image: true },
  "image/gif": { ext: "gif", image: true },
  "image/webp": { ext: "webp", image: true },
  "application/pdf": { ext: "pdf", image: false },
  "text/plain": { ext: "txt", image: false },
  "text/markdown": { ext: "md", image: false },
  "text/csv": { ext: "csv", image: false },
  "application/json": { ext: "json", image: false },
};
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB — matches config default
export const ATTACHMENT_MAX_PER_MESSAGE = 10;
// `accept` string for the file input: every allowed mime + the common extensions
// (some browsers report empty/oddball mime for .md/.csv, so list extensions too).
export const ATTACHMENT_ACCEPT = [
  ...Object.keys(ATTACHMENT_ALLOWED_MIME),
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".txt", ".md", ".csv", ".json",
].join(",");

export function isAllowedAttachmentMime(mime) {
  return Object.prototype.hasOwnProperty.call(ATTACHMENT_ALLOWED_MIME, mime);
}
export function isImageAttachmentMime(mime) {
  return Boolean(ATTACHMENT_ALLOWED_MIME[mime]?.image);
}
// Browsers occasionally hand back "" or a generic type for text/markdown/csv;
// fall back to the file extension so the pre-flight check + thumbnail logic agree
// with what the server will accept.
export function resolveAttachmentMime(file) {
  const byType = String(file.type || "").toLowerCase();
  if (isAllowedAttachmentMime(byType)) return byType;
  const ext = String(file.name || "").toLowerCase().split(".").pop();
  const fromExt = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  }[ext];
  return fromExt || byType || "application/octet-stream";
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

/* ---------- attachment icons ---------- */

export function PaperclipIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function FileIcon({ ext }) {
  return (
    <span className="att-chip__icon" aria-hidden="true">
      <svg width="20" height="24" viewBox="0 0 24 28" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        <path d="M4 2h11l5 5v19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
        <path d="M15 2v5h5" />
      </svg>
      {ext ? <span className="att-chip__ext">{ext}</span> : null}
    </span>
  );
}

function SpinnerDot() {
  return <span className="att-spinner" aria-label="Loading" />;
}

/* ---------- attachment renderers (chat bubbles) ----------
   The download route requires an Authorization header, so we fetch the bytes
   with the operator's Bearer token, build an object URL, and revoke it on
   unmount. Never point an <img src> straight at the route. */

export function AttachmentImage({ token, id, filename, mime, size, onLoad }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    let revoked = false;
    let objectUrl = "";
    setUrl("");
    setError(false);
    fetchAttachmentObjectUrl(token, id)
      .then((u) => {
        if (revoked) {
          URL.revokeObjectURL(u);
          return;
        }
        objectUrl = u;
        setUrl(u);
      })
      .catch(() => {
        if (!revoked) setError(true);
      });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token, id]);

  const openFull = () => {
    if (url) window.open(url, "_blank", "noopener");
  };

  if (error) {
    return <AttachmentChip token={token} id={id} filename={filename} mime={mime} size={size} />;
  }
  return (
    <figure className="att-image">
      {url ? (
        <button type="button" className="att-image__btn" onClick={openFull} title={`Open ${filename}`}>
          <img src={url} alt={filename} loading="lazy" onLoad={() => onLoad?.()} />
        </button>
      ) : (
        <div className="att-image__loading"><SpinnerDot /></div>
      )}
      <figcaption className="att-image__cap">
        <span className="att-image__name" title={filename}>{filename}</span>
        {size != null ? <span className="att-image__size">{formatBytes(size)}</span> : null}
      </figcaption>
    </figure>
  );
}

export function AttachmentChip({ token, id, filename, mime, size }) {
  const [busy, setBusy] = useState(false);
  const ext = (ATTACHMENT_ALLOWED_MIME[mime]?.ext || String(filename || "").split(".").pop() || "file").toUpperCase().slice(0, 4);

  const download = async () => {
    if (busy) return;
    setBusy(true);
    let objectUrl = "";
    try {
      objectUrl = await fetchAttachmentObjectUrl(token, id);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename || id;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      /* surfaced by the disabled→enabled toggle; the bubble stays intact */
    } finally {
      if (objectUrl) {
        // give the browser a tick to start the download before revoking
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
      }
      setBusy(false);
    }
  };

  return (
    <button type="button" className="att-chip" onClick={download} disabled={busy} title={`Download ${filename}`}>
      <FileIcon ext={ext} />
      <span className="att-chip__main">
        <span className="att-chip__name" title={filename}>{filename}</span>
        <span className="att-chip__meta">{size != null ? formatBytes(size) : mime}</span>
      </span>
      <span className="att-chip__action" aria-hidden="true">{busy ? <SpinnerDot /> : <DownloadGlyph />}</span>
    </button>
  );
}

function DownloadGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

// Render a list of attachment metadata on a chat bubble: images inline, docs as
// chips. `token` is required to fetch bytes (auth-gated route).
export function AttachmentList({ token, attachments, onImageLoad }) {
  if (!attachments?.length) return null;
  return (
    <div className="att-list">
      {attachments.map((att) =>
        isImageAttachmentMime(att.mime) ? (
          <AttachmentImage key={att.id} token={token} id={att.id} filename={att.filename} mime={att.mime} size={att.size_bytes} onLoad={onImageLoad} />
        ) : (
          <AttachmentChip key={att.id} token={token} id={att.id} filename={att.filename} mime={att.mime} size={att.size_bytes} />
        )
      )}
    </div>
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
