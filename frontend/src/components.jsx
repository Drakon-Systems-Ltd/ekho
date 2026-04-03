import React from "react";

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

export function KpiCard({ label, value }) {
  return (
    <article className="kpi-card">
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
