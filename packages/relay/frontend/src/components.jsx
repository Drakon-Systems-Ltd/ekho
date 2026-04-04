import React, { useState } from "react";

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
    normalized.includes("warn")
  ) {
    return "warn";
  }
  if (
    normalized.includes("reject") ||
    normalized.includes("quarantine") ||
    normalized.includes("paused") ||
    normalized.includes("cancel") ||
    normalized.includes("deny")
  ) {
    return "danger";
  }
  return "";
}

export function Badge({ children }) {
  const tone = toneForValue(children);
  return <span className={`badge ${tone ? `badge--${tone}` : ""}`}>{children}</span>;
}

export function StatusMessage({ tone = "", children }) {
  return <div className={`status-message${tone ? ` status-message--${tone}` : ""}`}>{children}</div>;
}

export function EmptyState({ children }) {
  return <div className="empty-state">{children}</div>;
}

export function Panel({ title, meta, children }) {
  return (
    <section className="panel">
      <div className="panel__header">
        <h2>{title}</h2>
        {meta ? <span className="panel__meta">{meta}</span> : null}
      </div>
      <div className="panel__body">{children}</div>
    </section>
  );
}

export function KpiCard({ label, value, tone }) {
  return (
    <article className={`kpi-card${tone ? ` kpi-card--${tone}` : ""}`}>
      <div className="kpi-card__label">{label}</div>
      <div className="kpi-card__value">{value}</div>
    </article>
  );
}

export function FilterBar({ children }) {
  return <div className="filter-bar">{children}</div>;
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
      <button className="button button--ghost" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
        Prev
      </button>
      <span className="pagination__meta">
        Page {page} of {totalPages}
      </span>
      <button className="button button--ghost" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}>
        Next
      </button>
    </div>
  );
}

export function EventFeed({ events, onConversationSelect }) {
  if (!events.length) {
    return <EmptyState>No recent events.</EmptyState>;
  }

  return (
    <div className="event-feed">
      {events.map((event) => (
        <div className="event-feed__row" key={`${event.event_type}-${event.created_at}-${event.resource_id || "none"}`}>
          <div className="card__head">
            <div className="card__title">{event.event_type}</div>
            <div className="meta-text">{event.created_at}</div>
          </div>
          <div className="meta-text code">
            {event.actor_kind}:{event.actor_id || "system"} → {event.resource_kind}:{event.resource_id || "-"}
          </div>
          {event.conversation_id ? (
            <div>
              <button className="link-button" onClick={() => onConversationSelect(event.conversation_id)}>
                Open conversation trace
              </button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function prettyJson(raw) {
  if (!raw) return "{}";
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return String(raw);
  }
}

function eventTone(eventType) {
  if (eventType.includes("approval")) return "approval";
  if (eventType.includes("pause") || eventType.includes("quarantine") || eventType.includes("control")) return "control";
  return "default";
}

export function Timeline({ conversationId, events, onRefresh }) {
  return (
    <>
      <div className="timeline-toolbar">
        {conversationId ? (
          <button className="button button--ghost" onClick={onRefresh}>
            Refresh Timeline
          </button>
        ) : null}
      </div>
      <div className="timeline">
        {!conversationId ? (
          <EmptyState>No conversation selected.</EmptyState>
        ) : !events.length ? (
          <EmptyState>No timeline data for this conversation.</EmptyState>
        ) : (
          events.map((event) => {
            const tone = eventTone(event.event_type);
            return (
              <div className="timeline-item" key={`${event.event_type}-${event.created_at}-${event.resource_id || "none"}`}>
                <div className="timeline-time">{event.created_at}</div>
                <div className="timeline-rail">
                  <div
                    className={`timeline-dot ${
                      tone === "approval"
                        ? "timeline-dot--approval"
                        : tone === "control"
                          ? "timeline-dot--control"
                          : ""
                    }`}
                  />
                </div>
                <article className="timeline-card">
                  <div className="timeline-card__head">
                    <div className="card__title">{event.event_type}</div>
                    <Badge>{event.resource_kind}</Badge>
                  </div>
                  <div className="timeline-card__meta">
                    {event.actor_kind}:{event.actor_id || "system"} → {event.resource_kind}:{event.resource_id || "-"}
                  </div>
                  <div className="timeline-payload">{prettyJson(event.payload_json)}</div>
                </article>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

export function Modal({ title, children, onClose, actions = [] }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>{title}</h2>
          <button className="button button--ghost modal__close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal__body">{children}</div>
        {actions.length > 0 && (
          <div className="modal__footer">
            {actions.map((action, i) => (
              <button key={i} className={`button ${action.variant ? `button--${action.variant}` : ""}`} onClick={action.onClick} disabled={action.disabled}>
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
    <Modal title={title} onClose={onCancel} actions={[
      { label: "Cancel", onClick: onCancel, variant: "ghost" },
      { label: confirmLabel, onClick: onConfirm, variant: confirmVariant },
    ]}>
      <p style={{ margin: 0, lineHeight: 1.6 }}>{message}</p>
    </Modal>
  );
}

export function PromptDialog({ title, message, defaultValue = "", onConfirm, onCancel }) {
  const [value, setValue] = useState(defaultValue);
  return (
    <Modal title={title} onClose={onCancel} actions={[
      { label: "Cancel", onClick: onCancel, variant: "ghost" },
      { label: "Confirm", onClick: () => onConfirm(value), disabled: !value.trim() },
    ]}>
      <p style={{ margin: "0 0 12px", lineHeight: 1.6 }}>{message}</p>
      <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
    </Modal>
  );
}

export function LoadingSpinner() {
  return <div className="loading-spinner" />;
}

export function Skeleton({ width = "100%", height = "16px", count = 1 }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ width, height }} />
      ))}
    </>
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
        <div className="console-shell">
          <Panel title="Something went wrong">
            <StatusMessage tone="error">{this.state.error?.message || "Unknown error"}</StatusMessage>
            <button className="button" style={{ marginTop: 16 }} onClick={() => this.setState({ hasError: false, error: null })}>
              Try Again
            </button>
          </Panel>
        </div>
      );
    }
    return this.props.children;
  }
}
