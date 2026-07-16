// Wire Ops Center — the operational surfaces (health, needs-you, approvals,
// policies, dead letters, topology, activity, feeds, security) as a full-screen
// space off the sidebar footer, so ops never competes with conversation. All
// behavior comes from useConsoleState(); this file is render-only.
import React, { useMemo, useState } from "react";
import { Badge, EmptyState, Modal, Skeleton, relativeTime, clockTime } from "./components.jsx";
import SecurityScreen from "./SecurityScreen.jsx";
import { humanizeEvent, parsePayload } from "./consoleState.js";
import { WireAvatar, presenceOf } from "./wireIdentity.jsx";

/* ---------- shared bits ---------- */

function BackIcon() {
  return <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>;
}

function healthLevel(agent) {
  const level = agent?.health?.level;
  if (level === "down") return "down";
  if (level === "degraded" || level === "slow") return "degraded";
  if (agent?.status === "quarantined" || agent?.status === "paused") return "down";
  if (agent?.status === "degraded") return "degraded";
  return "ok";
}

const ATTENTION_GLYPH = { agent_down: "⏻", agent_degraded: "▽", stalled: "⏸", dead_letter: "✉" };
const ATTENTION_TONE = { agent_down: "dn", agent_degraded: "st", stalled: "st", dead_letter: "dl" };

/** Attention Ledger items — shared by the bell popover and the Needs-You
 *  section. Stalled threads get an inline ▶ Resume; approvals get inline
 *  Approve / Reject (both still route through the existing confirm flow). */
export function LedgerItems({ S, onOpenConversation, onResumeThread, compact = false }) {
  const items = S.attention?.items || [];
  const pendingApprovals = (S.approvals || []).filter((a) => a.status === "pending");
  if (!items.length && !pendingApprovals.length) {
    return <div className="nu-empty">All quiet — nothing needs you.</div>;
  }
  return (
    <>
      {items.map((it) => (
        <div className="nu-item" key={it.id}>
          <span className={`pi ${ATTENTION_TONE[it.kind] || "st"}`}>{ATTENTION_GLYPH[it.kind] || "!"}</span>
          <span className="tx">
            <b>{it.title}</b>
            <p>{it.detail}</p>
            <time>{it.severity === "critical" ? "critical · " : ""}{relativeTime(it.at)}</time>
          </span>
          <span className="nu-acts">
            {it.kind === "stalled" && it.conversationId ? (
              <button className="act warn" onClick={() => onResumeThread(it.conversationId)}>▶ Resume</button>
            ) : null}
            {it.conversationId ? (
              <button className="act" onClick={() => onOpenConversation(it.conversationId)}>Open</button>
            ) : it.agentId ? (
              <button className="act" onClick={() => onOpenConversation(null, it.agentId)}>View agent</button>
            ) : null}
          </span>
        </div>
      ))}
      {pendingApprovals.slice(0, compact ? 4 : 50).map((a) => (
        <div className="nu-item" key={a.id}>
          <span className="pi ap">✓</span>
          <span className="tx">
            <b>{S.nameFor(a.agent_id)} asks approval</b>
            <p>{a.summary}</p>
            <time>{a.risk_level} risk · {relativeTime(a.requested_at)}</time>
          </span>
          <span className="nu-acts">
            <button className="act ok" onClick={() => S.handleApproval(a.id, "approve")}>Approve</button>
            <button className="act rej" onClick={() => S.handleApproval(a.id, "reject")}>Reject</button>
          </span>
        </div>
      ))}
    </>
  );
}

/* ---------- topology ---------- */

function WireTopology({ S, onSelectAgent }) {
  const [hot, setHot] = useState("");
  const nodes = S.topology?.nodes || [];
  const edges = S.topology?.edges || [];
  const layout = useMemo(() => {
    const ids = nodes.map((n) => n.id).sort();
    const W = 560, H = 380, cx = W / 2, cy = H / 2, R = 140;
    const pos = new Map();
    ids.forEach((id, i) => {
      const a = (i / Math.max(ids.length, 1)) * Math.PI * 2 - Math.PI / 2;
      pos.set(id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    });
    return { W, H, cx, cy, pos };
  }, [nodes.map((n) => n.id).sort().join(",")]);

  // Relay edges are {source, target, count, last_at}.
  const incident = useMemo(() => {
    if (!hot) return null;
    const set = new Set([hot]);
    for (const e of edges) {
      if (e.source === hot) set.add(e.target);
      if (e.target === hot) set.add(e.source);
    }
    return set;
  }, [hot, edges]);

  return (
    <>
      <div className="topo-wrap">
        <svg viewBox={`0 0 ${layout.W} ${layout.H}`} role="img" aria-label="Fleet collaboration map">
          {nodes.map((n) => {
            const p = layout.pos.get(n.id);
            if (!p) return null;
            return <line key={`spoke-${n.id}`} x1={layout.cx} y1={layout.cy} x2={p.x} y2={p.y} stroke="var(--line)" strokeWidth="1" opacity={incident && !incident.has(n.id) ? 0.25 : 0.7} />;
          })}
          {edges.map((e, i) => {
            const a = layout.pos.get(e.source), b = layout.pos.get(e.target);
            if (!a || !b) return null;
            const lit = hot && (e.source === hot || e.target === hot);
            const dim = incident && !lit;
            return (
              <line key={`e-${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={lit ? "var(--op)" : "color-mix(in oklab, var(--op), transparent 55%)"}
                strokeWidth={Math.min(e.count || 1, 12) * 0.6 + 1.2}
                opacity={dim ? 0.15 : 0.85}>
                <title>{`${S.nameFor(e.source)} ↔ ${S.nameFor(e.target)} · ${e.count} message(s)`}</title>
              </line>
            );
          })}
          <circle cx={layout.cx} cy={layout.cy} r="26" fill="var(--paper2)" stroke="var(--line)" />
          <text x={layout.cx} y={layout.cy + 4} textAnchor="middle">EKHO</text>
          {nodes.map((n) => {
            const p = layout.pos.get(n.id);
            if (!p) return null;
            const traffic = (n.sent_1h || 0) + (n.received_1h || 0);
            const r = 16 + Math.min(traffic, 40) * 0.25;
            const lv = healthLevel(n);
            const ring = lv === "down" ? "var(--down)" : lv === "degraded" ? "var(--warn)" : "var(--ok)";
            const dim = incident && !incident.has(n.id);
            return (
              <g key={n.id} opacity={dim ? 0.3 : 1} style={{ cursor: "pointer" }}
                onMouseEnter={() => setHot(n.id)} onMouseLeave={() => setHot("")}
                onClick={() => onSelectAgent(n.id)}>
                <circle cx={p.x} cy={p.y} r={r} fill="var(--paper)" stroke={ring} strokeWidth="2.5" />
                <text x={p.x} y={p.y + 4} textAnchor="middle">{(S.nameFor(n.id) || "?").slice(0, 6)}</text>
                <title>{`${S.nameFor(n.id)} · ↑${n.sent_1h || 0} ↓${n.received_1h || 0} (1h)`}</title>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="topo-roster">
        {nodes.map((n) => {
          const links = edges.filter((e) => e.source === n.id || e.target === n.id).length;
          return (
            <button key={n.id} className={`topo-roster__row${hot === n.id ? " is-hot" : ""}`}
              onMouseEnter={() => setHot(n.id)} onMouseLeave={() => setHot("")}
              onClick={() => onSelectAgent(n.id)}>
              <WireAvatar name={S.nameFor(n.id)} size={26} />
              {S.nameFor(n.id)}
              <small>↑{n.sent_1h || 0} ↓{n.received_1h || 0} · {links ? `${links} link${links === 1 ? "" : "s"}` : "idle"}</small>
            </button>
          );
        })}
      </div>
      <p className="muted-note" style={{ marginTop: 8 }}>Who talked to whom in the last {S.topology?.window_minutes ?? 60} minutes. Click an agent to open their chat.</p>
    </>
  );
}

/* ---------- feeds admin ---------- */

function FeedsSection({ S }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [subs, setSubs] = useState([]);
  const [editingSubs, setEditingSubs] = useState(null); // feedId | null
  const [subDraft, setSubDraft] = useState([]);
  const toggle = (list, setList, id) => setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <>
      <h2>News feeds</h2>
      <p className="lede">Feeds are polled by the relay and delivered to subscribed agents as non-waking context — no turn quota spent.</p>
      <div className="apr" style={{ maxWidth: 680 }}>
        <label className="field"><span>Feed name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hacker News" /></label>
        <label className="field"><span>Feed URL</span>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></label>
        <div className="field"><span>Subscribers</span>
          <div className="mem-pick">
            {S.agents.map((a) => (
              <button key={a.id} className="mem-chip" aria-pressed={subs.includes(a.id)} onClick={() => toggle(subs, setSubs, a.id)}>
                <WireAvatar name={a.display_name} size={24} />{a.display_name}
              </button>
            ))}
          </div>
        </div>
        <div className="acts" style={{ marginTop: 10 }}>
          <button className="ok-btn" disabled={!name.trim() || !url.trim() || S.feedBusy === "create"}
            onClick={async () => { await S.handleCreateFeed({ name: name.trim(), url: url.trim(), subscriberAgentIds: subs }); setName(""); setUrl(""); setSubs([]); }}>
            {S.feedBusy === "create" ? "Adding…" : "Add feed"}
          </button>
        </div>
      </div>
      {(S.feeds || []).map((f) => (
        <div className="feedcard" key={f.id}>
          <div className="fhead">📰 {f.name}<span className="pill">{f.item_count ?? 0} items</span></div>
          <div className="furl">{f.url}</div>
          <div className="fstats">{(f.subscribers || []).length} subscriber{(f.subscribers || []).length === 1 ? "" : "s"} · {f.last_polled_at ? `polled ${relativeTime(f.last_polled_at)}` : "not polled yet"}</div>
          {editingSubs === f.id ? (
            <>
              <div className="mem-pick" style={{ marginTop: 8 }}>
                {S.agents.map((a) => (
                  <button key={a.id} className="mem-chip" aria-pressed={subDraft.includes(a.id)} onClick={() => setSubDraft(toggleList(subDraft, a.id))}>
                    <WireAvatar name={a.display_name} size={24} />{a.display_name}
                  </button>
                ))}
              </div>
              <div className="facts">
                <button className="ok-btn" disabled={S.feedBusy === `subs-${f.id}`}
                  onClick={async () => { await S.handleSetFeedSubscribers(f.id, subDraft); setEditingSubs(null); }}>
                  {S.feedBusy === `subs-${f.id}` ? "Saving…" : "Save subscribers"}
                </button>
                <button className="rej-btn" onClick={() => setEditingSubs(null)}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <div className="subchips">
                {(f.subscribers || []).length
                  ? f.subscribers.map((s) => <span className="pill" key={s.agent_id || s}>{s.display_name || S.nameFor(s.agent_id || s)}</span>)
                  : <span className="muted-note">No subscribers yet.</span>}
              </div>
              <div className="facts">
                <button className="rej-btn" onClick={() => { setEditingSubs(f.id); setSubDraft((f.subscribers || []).map((s) => s.agent_id || s)); }}>Subscribers</button>
                <button className="rej-btn" disabled={S.feedBusy === f.id} onClick={() => S.handlePollFeed(f.id)}>{S.feedBusy === f.id ? "Polling…" : "Poll now"}</button>
                <button className="rej-btn" style={{ color: "var(--down)" }} onClick={() => S.handleDeleteFeed(f.id)}>Delete</button>
              </div>
            </>
          )}
        </div>
      ))}
      {!(S.feeds || []).length ? <EmptyState title="No feeds yet">Add a source above to pipe headlines to your agents.</EmptyState> : null}
    </>
  );
}
function toggleList(list, id) { return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]; }

/* ---------- activity ---------- */

function ActivitySection({ S, onOpenConversation }) {
  const [open, setOpen] = useState("");
  const groups = useMemo(() => {
    const byConv = new Map();
    const fleet = [];
    for (const e of S.activity || []) {
      if (e.conversation_id) {
        const g = byConv.get(e.conversation_id) || [];
        g.push(e);
        byConv.set(e.conversation_id, g);
      } else fleet.push(e);
    }
    return { byConv: Array.from(byConv.entries()), fleet };
  }, [S.activity]);

  const line = (e) => {
    // The activity endpoint returns a pre-parsed `payload` object.
    const p = e.payload && typeof e.payload === "object" ? e.payload : parsePayload(e.payload_json);
    if (e.event_type === "message.queued") {
      const to = p.recipient_id ? S.nameFor(p.recipient_id) : p.recipient_kind || "";
      return `${S.nameFor(e.actor_id)} → ${to}: ${(p.text || "").slice(0, 90)}`;
    }
    return `${S.nameFor(e.actor_id) || "system"} · ${humanizeEvent(e.event_type, p)}`;
  };

  return (
    <>
      <h2>Activity</h2>
      <p className="lede">Everything the fleet did recently, grouped by conversation.</p>
      <div className="ops-toolbar">
        {[["", "All"], ["message", "Messages"], ["room", "Rooms"], ["agent", "Changes"]].map(([val, label]) => (
          <button key={val || "all"} className="chipbtn" aria-pressed={S.activityFilter === val}
            onClick={() => S.setActivityFilter(val)}>{label}</button>
        ))}
      </div>
      {groups.byConv.map(([conv, events]) => (
        <div className="actgroup" key={conv}>
          <button onClick={() => setOpen(open === conv ? "" : conv)}>
            <b>{S.convTitle(conv)}</b>
            <span className="gx">{events.length} event{events.length === 1 ? "" : "s"} · {relativeTime(events[0]?.created_at)}</span>
          </button>
          {open === conv ? (
            <div className="gevents">
              {events.slice(0, 20).map((e) => <span key={e.id}>{clockTime(e.created_at)} — {line(e)}</span>)}
              <button className="linky" style={{ color: "var(--op)", fontWeight: 650, textAlign: "left" }} onClick={() => onOpenConversation(conv)}>Open conversation →</button>
            </div>
          ) : null}
        </div>
      ))}
      {groups.fleet.length ? (
        <div className="actgroup">
          <button onClick={() => setOpen(open === "__fleet__" ? "" : "__fleet__")}>
            <b>Fleet changes</b><span className="gx">{groups.fleet.length}</span>
          </button>
          {open === "__fleet__" ? (
            <div className="gevents">{groups.fleet.slice(0, 25).map((e) => <span key={e.id}>{clockTime(e.created_at)} — {line(e)}</span>)}</div>
          ) : null}
        </div>
      ) : null}
      {!groups.byConv.length && !groups.fleet.length ? <EmptyState title="No activity yet">The fleet has been quiet.</EmptyState> : null}
    </>
  );
}

/* ---------- policy editor ---------- */

export function WirePolicyModal({ S }) {
  if (!S.policyModalOpen) return null;
  // policyForm shape (consoleState): { name, scope_kind, scope_id,
  //   rule: { action, conditions: { message_types?, sender_ids? } }, enabled }
  const f = S.policyForm;
  const rule = f.rule || { action: "deny", conditions: {} };
  const cond = rule.conditions || {};
  const set = (k, v) => S.setPolicyForm((prev) => ({ ...prev, [k]: v }));
  const setRule = (k, v) => S.setPolicyForm((prev) => ({ ...prev, rule: { ...(prev.rule || {}), conditions: { ...((prev.rule || {}).conditions || {}) }, [k]: v } }));
  const setCond = (k, v) => S.setPolicyForm((prev) => {
    const r = prev.rule || { action: "deny", conditions: {} };
    return { ...prev, rule: { ...r, conditions: { ...(r.conditions || {}), [k]: v } } };
  });
  const parseList = (v) => v.split(",").map((t) => t.trim()).filter(Boolean);
  return (
    <Modal title={S.editingPolicy ? "Edit policy" : "Create policy"} onClose={() => S.setPolicyModalOpen(false)}
      actions={[
        { label: "Cancel", onClick: () => S.setPolicyModalOpen(false), variant: "ghost" },
        { label: S.editingPolicy ? "Save changes" : "Create", onClick: S.handlePolicySave, variant: "primary" },
      ]}>
      <label className="field"><span>Name</span><input type="text" value={f.name} onChange={(e) => set("name", e.target.value)} /></label>
      <label className="field"><span>Scope</span>
        <select value={f.scope_kind} onChange={(e) => set("scope_kind", e.target.value)}>
          <option value="fleet">Fleet-wide</option>
          <option value="agent">Agent-specific</option>
        </select></label>
      {f.scope_kind === "agent" ? (
        <label className="field"><span>Scope agent id</span><input type="text" value={f.scope_id} onChange={(e) => set("scope_id", e.target.value)} placeholder="agent_…" /></label>
      ) : null}
      <label className="field"><span>Action</span>
        <select value={rule.action || "deny"} onChange={(e) => setRule("action", e.target.value)}>
          <option value="deny">Deny</option>
          <option value="allow">Allow</option>
        </select></label>
      <label className="field"><span>Message types (comma separated)</span>
        <input type="text" defaultValue={(cond.message_types || []).join(", ")}
          key={`mt-${S.editingPolicy?.id || "new"}`}
          onChange={(e) => setCond("message_types", parseList(e.target.value))} placeholder="direct, broadcast" /></label>
      <label className="field"><span>Sender agent ids (comma separated)</span>
        <input type="text" defaultValue={(cond.sender_ids || []).join(", ")}
          key={`si-${S.editingPolicy?.id || "new"}`}
          onChange={(e) => setCond("sender_ids", parseList(e.target.value))} /></label>
      <label className="toggle"><input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Enabled</label>
      {S.policyStatus ? <p className="status-message status-message--error">{S.policyStatus}</p> : null}
    </Modal>
  );
}

/* ---------- the ops center ---------- */

const SECTIONS = [
  ["needs", "Needs you"],
  ["health", "Fleet health"],
  ["approvals", "Approvals"],
  ["policies", "Policies"],
  ["dead", "Dead letters"],
  ["topo", "Topology"],
  ["activity", "Activity"],
  ["feeds", "Feeds"],
  ["sec", "Security"],
];

export function OpsCenter({ S, section, setSection, onClose, onOpenConversation, onResumeThread, needsCount, density, setDensity }) {
  const healthAgents = useMemo(() => {
    const rank = { down: 0, degraded: 1, ok: 2 };
    return [...(S.fleetHealth || [])].sort((a, b) => (rank[healthLevel(a)] ?? 2) - (rank[healthLevel(b)] ?? 2));
  }, [S.fleetHealth]);

  return (
    <section className="ops" aria-label="Ops Center">
      <nav className="ops-nav">
        <button className="back" onClick={onClose}><BackIcon />Chats</button>
        {SECTIONS.map(([key, label]) => (
          <button key={key} className="onav" aria-selected={section === key} onClick={() => setSection(key)}>
            {label}
            {key === "needs" ? <span className="ct">{needsCount || ""}</span> : null}
            {key === "approvals" ? <span className="ct">{(S.approvals || []).filter((a) => a.status === "pending").length || ""}</span> : null}
          </button>
        ))}
        <div className="ops-foot">
          <button className="onav" onClick={S.handleIssueToken}>Mint enrollment token</button>
          {S.tokenStatus ? <div className={`token-out${S.tokenTone === "error" ? " token-out--error" : ""}`}>{S.tokenStatus}</div> : null}
          {setDensity ? (
            <button className="onav" onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}>
              Density: {density === "compact" ? "compact" : "comfortable"}
            </button>
          ) : null}
        </div>
      </nav>
      <div className="ops-body">
        {section === "needs" ? (
          <>
            <h2>Needs you</h2>
            <p className="lede">Everything waiting on the operator, worst first. Clear this list and the fleet runs itself.</p>
            <div style={{ maxWidth: 680, background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 16, overflow: "hidden" }}>
              <LedgerItems S={S} onOpenConversation={onOpenConversation} onResumeThread={onResumeThread} />
            </div>
          </>
        ) : null}

        {section === "health" ? (
          <>
            <h2>Fleet health</h2>
            <p className="lede">Truthful per-agent verdicts, worst first.</p>
            {!S.initialized.current.health ? <Skeleton count={4} height="64px" /> : healthAgents.map((a) => {
              const lv = healthLevel(a);
              return (
                <div className={`hcard ${lv !== "ok" ? lv : ""}`} key={a.id}>
                  <WireAvatar name={a.display_name} presence={presenceOf(a)} size={42} />
                  <div>
                    <div className="nm">{a.display_name}
                      <span className="rt">{a.runtime}</span>
                      {a.metrics?.model ? <span className="pill">{a.metrics.model}{a.metrics.provider ? ` · ${a.metrics.provider}` : ""}</span> : null}
                      {a.operator_trusted ? null : <span className="pill warn">untrusted</span>}
                      {a.peer_autoreply ? <span className="pill">delegation · {a.peer_turn_budget}</span> : <span className="pill">solo</span>}
                    </div>
                    {lv !== "ok" && a.health?.reason ? <div className="why">{a.health.reason}</div> : null}
                    <div className="stats">
                      ↑{a.sent_1h ?? 0} ↓{a.received_1h ?? 0} (1h) · {(a.active_conversations || []).length} active conv · hb {a.last_heartbeat_at ? relativeTime(a.last_heartbeat_at) : "—"}
                    </div>
                  </div>
                  <span className={`vd ${lv}`}>{lv === "ok" ? "OK" : lv === "degraded" ? "Degraded" : "Down"}</span>
                </div>
              );
            })}
          </>
        ) : null}

        {section === "approvals" ? (
          <>
            <h2>Approvals</h2>
            <p className="lede">Actions agents proposed that need your decision.</p>
            {(S.approvals || []).length ? S.approvals.map((a) => (
              <div className="apr" key={a.id}>
                <div className="top">
                  <WireAvatar name={S.nameFor(a.agent_id)} size={30} />
                  {S.nameFor(a.agent_id)}
                  <span className={`risk ${a.risk_level || "low"}`}>{a.risk_level || "?"}</span>
                  <span className="pill">{a.action_type}</span>
                  <time>{relativeTime(a.requested_at)}</time>
                </div>
                <p>{a.summary}</p>
                {a.status === "pending" ? (
                  <div className="acts">
                    <button className="ok-btn" onClick={() => S.handleApproval(a.id, "approve")}>Approve</button>
                    <button className="rej-btn" onClick={() => S.handleApproval(a.id, "reject")}>Reject</button>
                    {a.conversation_id ? <button className="rej-btn" onClick={() => onOpenConversation(a.conversation_id)}>Open thread</button> : null}
                  </div>
                ) : <Badge tone={a.status === "approved" ? "ok" : "danger"}>{a.status}</Badge>}
              </div>
            )) : <EmptyState title="Queue clear">No pending approvals.</EmptyState>}
          </>
        ) : null}

        {section === "policies" ? (
          <>
            <h2>Policies</h2>
            <p className="lede">Rules that allow or deny message routing across the fleet.</p>
            <div className="ops-toolbar"><button className="ok-btn" onClick={S.openPolicyCreate}>Create policy</button></div>
            {(S.policies || []).length ? S.policies.map((p) => {
              const rule = (() => { try { return JSON.parse(p.rule_json || "{}"); } catch { return {}; } })();
              return (
                <div className="apr" key={p.id}>
                  <div className="top">{p.name}
                    <span className={`pill ${p.enabled ? "on" : "off"}`}>{p.enabled ? "on" : "off"}</span>
                    <span className="pill">{p.scope_kind}{p.scope_id ? `: ${S.nameFor(p.scope_id)}` : ""}</span>
                    <span className="pill">{rule.action || "allow"}</span>
                  </div>
                  <div className="acts">
                    <button className="rej-btn" onClick={() => S.openPolicyEdit(p)}>Edit</button>
                    <button className="rej-btn" style={{ color: "var(--down)" }} onClick={() => S.handlePolicyDelete(p.id)}>Delete</button>
                  </div>
                </div>
              );
            }) : <EmptyState title="No policies">Create one to control routing.</EmptyState>}
          </>
        ) : null}

        {section === "dead" ? (
          <>
            <h2>Dead letters</h2>
            <p className="lede">Messages that permanently failed delivery ({S.deadLettersTotal} total).</p>
            {(S.deadLetters || []).length ? S.deadLetters.map((d) => (
              <div className="apr" key={d.id}>
                <div className="top">{d.message_type}
                  <span className="pill">{d.retry_count ?? 0} retries</span>
                  <time>{relativeTime(d.failed_at || d.created_at)}</time>
                </div>
                <p>{S.nameFor(d.sender_agent_id)} → {S.nameFor(d.recipient_agent_id) || d.recipient_kind} · {d.failure_reason}</p>
                <div className="acts">
                  <button className="rej-btn" onClick={() => S.handleExpandDeadLetter(d)}>{S.expandedDeadLetter?.id === d.id ? "Hide detail" : "Detail"}</button>
                  {d.conversation_id ? <button className="rej-btn" onClick={() => onOpenConversation(d.conversation_id)}>Open thread</button> : null}
                </div>
                {S.expandedDeadLetter?.id === d.id ? <pre className="code-block">{JSON.stringify(S.expandedDeadLetter, null, 2)}</pre> : null}
              </div>
            )) : <EmptyState title="All delivered">No dead letters.</EmptyState>}
          </>
        ) : null}

        {section === "topo" ? (
          <>
            <h2>Topology</h2>
            <p className="lede">The fleet's collaboration map.</p>
            <WireTopology S={S} onSelectAgent={(id) => onOpenConversation(null, id)} />
          </>
        ) : null}

        {section === "activity" ? <ActivitySection S={S} onOpenConversation={onOpenConversation} /> : null}
        {section === "feeds" ? <FeedsSection S={S} /> : null}

        {section === "sec" ? (
          <>
            <h2>Security</h2>
            <p className="lede">Operator signing identity, registered keys and agent key endorsements.</p>
            <SecurityScreen session={S.session} agents={S.agents} />
          </>
        ) : null}
      </div>
    </section>
  );
}
