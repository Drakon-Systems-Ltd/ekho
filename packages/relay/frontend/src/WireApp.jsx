// Wire — the Ekho operator console as a first-class messenger.
// All state and behavior lives in useConsoleState() (shared with the classic
// console at #classic); this file is the Telegram-grade render layer:
// fleet strip, folder tabs, chat list with previews/unread/pins, a composer
// that sends to the open chat, a contextual info panel, the attention-ledger
// bell, and a full-screen Ops Center.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./wire.css";
import {
  useConsoleState, describeEvent, humanizeEvent, isHeartbeatEvent,
  dayKey, dayDividerLabel, verificationOf, NEW_MESSAGE_MS,
} from "./consoleState.js";
import {
  AttachmentList, ConfirmDialog, EmptyState, HelpModal, Modal, PromptDialog,
  SettingsModal, Skeleton, StatusMessage, Typewriter, prefersReducedMotion,
  formatBytes, relativeTime, clockTime, ATTACHMENT_ACCEPT, ATTACHMENT_MAX_PER_MESSAGE,
} from "./components.jsx";
import { WireAvatar, RoomAvatar, ChannelMark, Tick, castSlug, fallbackHue, presenceOf } from "./wireIdentity.jsx";
import { OpsCenter, LedgerItems, WirePolicyModal } from "./WireOps.jsx";
import { resumeConversation as apiResumeConversation } from "./api.js";

/* ================= small utilities ================= */

function useLocalPref(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw == null ? initial : JSON.parse(raw);
    } catch { return initial; }
  });
  const set = (next) => {
    setValue((prev) => {
      const v = typeof next === "function" ? next(prev) : next;
      try { window.localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ }
      return v;
    });
  };
  return [value, set];
}

// Same token rule as the classic console: only @word tokens matching known
// agent names highlight; everything else stays literal text.
function MentionText({ text, names }) {
  const parts = String(text ?? "").split(/(@[\w-]+)/g);
  return parts.map((part, i) => {
    if (/^@[\w-]+$/.test(part) && names.has(part.slice(1).toLowerCase())) {
      return <span key={i} className="mention">{part}</span>;
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

const I = {
  logo: <svg viewBox="0 0 24 24"><path d="M4 12h4l3-7 3 14 3-7h3" /></svg>,
  bell: <svg viewBox="0 0 24 24"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" /><path d="M10 19a2 2 0 0 0 4 0" /></svg>,
  gear: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2.1-1.2L14 3h-4l-.5 2.7a7 7 0 0 0-2.1 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1c.6.5 1.4.9 2.1 1.2L10 21h4l.5-2.7a7 7 0 0 0 2.1-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" /></svg>,
  help: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M9.2 9.2a2.8 2.8 0 0 1 5.4.9c0 1.8-2.6 2.3-2.6 3.9M12 17.2v.1" /></svg>,
  theme: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17M12 3.5a8.5 8.5 0 0 1 0 17" className="f" /></svg>,
  out: <svg viewBox="0 0 24 24"><path d="M9 4H5v16h4M14 8l4 4-4 4M18 12H9" /></svg>,
  deck: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 12L17 8M12 3.5V6M20.5 12H18M12 18v2.5M6 12H3.5" /></svg>,
  back: <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>,
  info: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></svg>,
  x: <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>,
  plus: <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>,
  send: <svg viewBox="0 0 24 24"><path d="M4.5 12L20 4.5 15.5 20l-3-6.5L4.5 12z" /></svg>,
  clip: <svg viewBox="0 0 24 24"><path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.4a1.6 1.6 0 0 1-2.3-2.3L14.9 7.5" /></svg>,
  pin: <svg viewBox="0 0 24 24" className="pin"><path d="M12 3l4 4-1 1 2 5-3 1-2.5 6.5L10 14l-5-1 1-3 1-1z" /></svg>,
  dm: <svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z" /></svg>,
  room: <svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3" /><circle cx="16.5" cy="9.5" r="2.5" /><path d="M3.5 19c.6-3 2.9-5 5.5-5s4.9 2 5.5 5M14.5 14.5c2 .3 3.6 1.9 4 4.5" /></svg>,
  bc: <svg viewBox="0 0 24 24"><path d="M4 10v4h3l6 4V6l-6 4H4z" /><path d="M17 9a4 4 0 0 1 0 6" /></svg>,
  refresh: <svg viewBox="0 0 24 24"><path d="M20 8A8.5 8.5 0 1 0 21 13" /><path d="M20 3v5h-5" /></svg>,
};

/* ================= login ================= */

function WireLogin({ S }) {
  return (
    <div className="boot-screen">
      <form className="auth-card" onSubmit={S.handleLoginSubmit}>
        <div className="auth-card__brand"><span className="brand"><span className="mark">{I.logo}</span></span>Ekho</div>
        <h1>Operator console</h1>
        <p>Sign in to command your fleet.</p>
        <label className="field"><span>Fleet</span>
          <input type="text" autoComplete="off" value={S.formState.fleet_name}
            onChange={(e) => S.setFormState((f) => ({ ...f, fleet_name: e.target.value }))} /></label>
        <label className="field"><span>Email</span>
          <input type="email" autoComplete="username" value={S.formState.email}
            onChange={(e) => S.setFormState((f) => ({ ...f, email: e.target.value }))} /></label>
        <label className="field"><span>Password</span>
          <input type="password" autoComplete="current-password" value={S.formState.password}
            onChange={(e) => S.setFormState((f) => ({ ...f, password: e.target.value }))} /></label>
        <button className="button button--block" type="submit">Sign in</button>
        <StatusMessage tone={S.loginTone}>{S.loginStatus}</StatusMessage>
      </form>
    </div>
  );
}

/* ================= chat scroller ================= */

function WireScroller({ S }) {
  const ref = useRef(null);
  const nearBottomRef = useRef(true);
  const items = S.chatItems;
  const animate = S.settings.typingAnimation && !prefersReducedMotion();

  const handleScroll = () => {
    const el = ref.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  const stickToBottom = () => {
    const el = ref.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(() => { stickToBottom(); }, [items.length, S.typingAgents.length, S.selectedConversationId]);

  if (!items.length && !S.typingAgents.length) {
    return (
      <div className="msgs" ref={ref}>
        <div className="msgs-inner">
          {S.selectedConversationId ? (
            <EmptyState title="No visible activity">This conversation has no messages yet — or only system events. Toggle “system” in the header, or send the first message.</EmptyState>
          ) : (
            <EmptyState icon="✦" title="No messages yet">Say hello — your message opens the thread.</EmptyState>
          )}
        </div>
      </div>
    );
  }

  const visible = items;
  return (
    <div className="msgs" ref={ref} onScroll={handleScroll} aria-live="polite">
      <div className="msgs-inner">
        {visible.map((item, idx) => {
          const prev = visible[idx - 1];
          const next = visible[idx + 1];
          const showDay = !prev || dayKey(prev.createdAt) !== dayKey(item.createdAt);
          const key = item.id || `${item.type}-${item.createdAt}-${idx}`;
          const day = showDay ? <div className="divider" key={`d-${key}`}><span>{dayDividerLabel(item.createdAt)}</span></div> : null;

          if (item.kind === "system") {
            if (item.variant === "stalled") {
              const live = !visible.slice(idx + 1).some((x) => (x.kind === "message" && x.side === "operator") || x.variant === "resumed");
              return (
                <React.Fragment key={key}>{day}
                  <div className="stall">
                    <span className="pi">⏸</span>
                    <span><b>{S.nameFor(item.senderId)}</b> hit the agent-to-agent turn budget{item.stallBudget ? ` (${item.stallBudget})` : ""} — paused until you nudge or resume.</span>
                    {live ? (
                      <button className="resume" disabled={S.resumePending} onClick={S.handleResumeConversation}>
                        {S.resumePending ? "Resuming…" : "▶ Resume"}
                      </button>
                    ) : null}
                  </div>
                </React.Fragment>
              );
            }
            if (item.variant === "resumed") {
              return <React.Fragment key={key}>{day}<div className="resumed"><span>▶ Thread resumed — fresh turn budget</span></div></React.Fragment>;
            }
            return <React.Fragment key={key}>{day}<div className="sysrow"><span className="sys">{item.text} · {clockTime(item.createdAt)}</span></div></React.Fragment>;
          }

          if (item.feed) {
            return (
              <React.Fragment key={key}>{day}
                <div className="feeditem">
                  <div className="src">📰 {item.feedName}<span className="ext">external</span><time>{clockTime(item.createdAt)}</time></div>
                  <p className="ftext">{item.text}</p>
                  {item.attachments?.length ? <AttachmentList token={S.session.token} attachments={item.attachments} onImageLoad={stickToBottom} /> : null}
                </div>
              </React.Fragment>
            );
          }

          const isOp = item.side === "operator";
          const sameAs = (o) => o && o.kind === "message" && !o.feed && o.side === item.side && o.senderId === item.senderId && dayKey(o.createdAt) === dayKey(item.createdAt);
          const first = !sameAs(prev) || showDay;
          const last = !sameAs(next) || (next && dayKey(next.createdAt) !== dayKey(item.createdAt));
          const name = isOp ? "You" : S.nameFor(item.senderId);
          // A settings colour override beats the cast hue (same rule everywhere).
          const hueOverride = !isOp ? S.settings.agentColors?.[item.senderId] : null;
          const slug = isOp || hueOverride ? null : castSlug(name);
          const rowStyle = !isOp && !slug ? { "--ag": hueOverride || fallbackHue(name) } : undefined;

          // Typewriter gating — identical to the classic console: fresh agent
          // messages animate once; polls never snap a mid-animation message.
          const ts = new Date(item.createdAt).getTime();
          const fresh = Number.isFinite(ts) && S.now - ts <= NEW_MESSAGE_MS;
          const mid = item.messageId;
          const done = mid && S.animatedIds.current.has(mid);
          const inFlight = mid && S.typingNow.current.has(mid);
          const startNew = animate && !isOp && mid && fresh && !done && !inFlight && !item.pending;
          if (startNew) S.typingNow.current.add(mid);
          const shouldType = animate && !isOp && mid && !done && (inFlight || startNew);

          // verificationOf returns a STRING: "verified" (operator-signed,
          // Ed25519-checked) | "attested" (relay-attested) | "" (pending).
          const verify = verificationOf(item);
          const verifyGlyph = verify === "verified"
            ? <span className="vfy ok" title="Operator-signed — cryptographically verified">✓</span>
            : verify === "attested"
              ? <span className="vfy" title="Relay-attested delivery">·</span>
              : null;
          return (
            <React.Fragment key={key}>{day}
              <div className={`m${isOp ? " op" : ""}${first ? " first" : ""}${last ? " last" : ""}${slug ? ` c-${slug}` : ""}`} style={rowStyle}>
                {!isOp ? (last ? <WireAvatar name={name} size={34} hue={hueOverride} /> : <span className="avspace" />) : null}
                <div className="bubble">
                  {!isOp && first ? (
                    <div className="sender">{name}
                      {item.recipientKind === "agent" && item.recipientId && !String(item.recipientId).startsWith("op_") ? (
                        <span className="peer-tag">→ {S.nameFor(item.recipientId)}</span>
                      ) : null}
                      {verifyGlyph}
                    </div>
                  ) : null}
                  {item.text ? (
                    <div className="btext">
                      {shouldType ? (
                        <Typewriter text={item.text} onTick={stickToBottom}
                          onDone={() => { S.typingNow.current.delete(mid); S.animatedIds.current.add(mid); }} />
                      ) : (
                        <MentionText text={item.text} names={S.mentionNames} />
                      )}
                    </div>
                  ) : null}
                  {item.attachments?.length ? <AttachmentList token={S.session.token} attachments={item.attachments} onImageLoad={stickToBottom} /> : null}
                  <span className="mtime"
                    title={isOp && item.status ? (
                      item.status === "pending" ? "Sending…"
                        : item.status === "read" ? `Acknowledged by ${item.ackedN ?? "all"}`
                        : item.status === "delivered" ? `Delivered to ${item.deliveredN ?? "?"}${item.ackedN ? ` · read by ${item.ackedN}` : ""}`
                        : "Sent") : undefined}>
                    {isOp ? verifyGlyph : null}
                    {clockTime(item.createdAt)}
                    {isOp && item.status ? <Tick status={item.status} /> : null}
                  </span>
                </div>
                {mid ? (
                  <button type="button" className="reply-btn" title="Reply"
                    onClick={() => S.setReplyTarget({ messageId: mid, text: item.text || "(attachment)", label: name })}>↩</button>
                ) : null}
              </div>
            </React.Fragment>
          );
        })}
        {S.typingAgents.filter(({ agentId }) => S.agents.some((a) => a.id === agentId)).map(({ agentId, label }) => {
          const hueOverride = S.settings.agentColors?.[agentId];
          const slug = hueOverride ? null : castSlug(label);
          return (
            <div className={`typing${slug ? ` c-${slug}` : ""}`} key={`t-${agentId}`} style={!slug ? { "--ag": hueOverride || fallbackHue(label) } : undefined}>
              <WireAvatar name={label} size={28} hue={hueOverride} />
              <span className="tb"><i /><i /><i /></span>
              <span className="lbl">{label} is replying…</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ================= info panel ================= */

function InfoPanel({ S, active, pins, togglePin, onClose, onOpenDm }) {
  if (!active) return null;
  const pinKey = active.key;
  const pinned = pins.includes(pinKey);

  const pinRow = (
    <button className="ghostbtn" onClick={() => togglePin(pinKey)}>{pinned ? "Unpin chat" : "Pin chat"}</button>
  );

  if (active.kind === "dm") {
    const agent = S.agents.find((a) => a.id === active.agentId) || {};
    const health = (S.fleetHealth || []).find((h) => h.id === active.agentId) || agent;
    const lv = health.health?.level === "down" || agent.status === "quarantined" || agent.status === "paused"
      ? "down"
      : (health.health?.level && health.health.level !== "ok") || agent.status === "degraded" ? "slow" : "ok";
    // consoleState stores the violations ARRAY itself.
    const violations = Array.isArray(S.agentRateLimits) ? S.agentRateLimits : (S.agentRateLimits?.violations || []);
    const recent = (S.agentDetail?.recentMessages || []).slice(0, 8);
    return (
      <div className="info-scroll">
        <div className="hero">
          <WireAvatar name={agent.display_name} presence={presenceOf(agent)} size={72} />
          <h2>{agent.display_name}</h2>
          <div className="sub">{agent.runtime} · seen {agent.last_seen_at ? relativeTime(agent.last_seen_at) : "never"}</div>
        </div>
        <div className="icard">
          <div className="ihead">Health</div>
          <div className="irow"><span className="lab healthline"><span className={`hdot ${lv !== "ok" ? lv : ""}`} />{lv === "ok" ? "All checks green" : (health.health?.reason || `Agent is ${agent.status}`)}</span></div>
          {health.metrics?.model ? <div className="irow"><span className="lab">Model</span><span className="val">{health.metrics.model}{health.metrics.provider ? ` · ${health.metrics.provider}` : ""}</span></div> : null}
          <div className="irow"><span className="lab">Status</span><span className="val">{agent.status}</span></div>
          <div className="irow"><span className="lab">Agent id</span><span className="val mono">{agent.id}</span></div>
        </div>
        <div className="icard">
          <div className="ihead">Access</div>
          <div className="irow">
            <span className="lab">Operator-trusted<small>Your messages wake this agent</small></span>
            <label className="switch"><input type="checkbox" checked={Boolean(agent.operator_trusted)}
              disabled={S.trustPending === agent.id}
              onChange={(e) => S.handleSetTrust(agent.id, e.target.checked)} /><span className="tr" /></label>
          </div>
          <div className="irow">
            <span className="lab">Delegation<small>Teammates may wake it, budget-bounded</small></span>
            <label className="switch"><input type="checkbox" checked={Boolean(agent.peer_autoreply)}
              disabled={S.peerPending === agent.id}
              onChange={(e) => S.handleSetPeerAutoreply(agent.id, e.target.checked)} /><span className="tr" /></label>
          </div>
          {agent.peer_autoreply ? (
            <div className="irow">
              <span className="lab">Turn budget<small>Peer wakes per conversation</small></span>
              <input className="budget-input" type="number" min="1" max="200" defaultValue={agent.peer_turn_budget ?? 25}
                key={`${agent.id}-${agent.peer_turn_budget}`}
                disabled={S.peerPending === agent.id}
                onBlur={(e) => {
                  const next = Math.max(1, Math.min(200, Math.trunc(Number(e.target.value) || agent.peer_turn_budget || 25)));
                  e.target.value = String(next);
                  if (next !== agent.peer_turn_budget) S.handleSetPeerAutoreply(agent.id, true, next);
                }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }} />
            </div>
          ) : null}
        </div>
        <div className="icard">
          <div className="ihead">Controls</div>
          <div className="irow" style={{ gap: 8 }}>
            {agent.status === "paused" || agent.status === "quarantined" ? (
              <button className="ghostbtn" style={{ margin: 0 }} onClick={() => S.handleControl(agent.id, "resume")}>Resume agent</button>
            ) : (
              <button className="ghostbtn" style={{ margin: 0 }} onClick={() => S.handleControl(agent.id, "pause")}>Pause agent</button>
            )}
            <button className="ghostbtn" style={{ margin: 0, color: "var(--down)" }} onClick={() => S.handleControl(agent.id, "quarantine")}>Quarantine</button>
          </div>
        </div>
        {violations.length ? (
          <div className="icard">
            <div className="ihead">Rate-limit violations</div>
            {violations.slice(0, 6).map((v, i) => (
              <div className="irow" key={i}><span className="lab">{v.message_count}/{v.limit_value} msgs<small>{relativeTime(v.window_start)}</small></span></div>
            ))}
          </div>
        ) : null}
        {recent.length ? (
          <div className="icard">
            <div className="ihead">Recent messages</div>
            {recent.map((m, i) => (
              <div className="irow" key={m.id || i}>
                <span className="lab" style={{ overflow: "hidden" }}>
                  <span style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {m.text || m.preview || m.message_type || "message"}
                  </span>
                  <small>{m.created_at ? relativeTime(m.created_at) : ""}</small>
                </span>
                {m.conversation_id ? <button className="linky" onClick={() => S.traceFromOps(m.conversation_id)}>Open</button> : null}
              </div>
            ))}
          </div>
        ) : null}
        {pinRow}
      </div>
    );
  }

  if (active.kind === "room") {
    const room = active.room;
    return (
      <div className="info-scroll">
        <div className="hero">
          <RoomAvatar members={(room.members || []).map((m) => m.display_name)} size={72} />
          <h2># {room.name}</h2>
          <div className="sub">{(room.members || []).length} member{(room.members || []).length === 1 ? "" : "s"}</div>
        </div>
        <div className="icard">
          <div className="ihead">Members</div>
          {(room.members || []).map((m) => (
            <div className="irow" key={m.agent_id}>
              <WireAvatar name={m.display_name} size={32} />
              <span className="lab">{m.display_name}<small>{m.status}</small></span>
              <button className="linky" onClick={() => onOpenDm(m.agent_id)}>Message</button>
            </div>
          ))}
        </div>
        <div className="icard">
          <div className="ihead">Project mode</div>
          <div className="irow">
            <span className="lab">Higher turn budget<small>For long working sessions in this room</small></span>
            <label className="switch"><input type="checkbox" checked={Boolean(room.project_mode)}
              onChange={(e) => S.handleSetProjectMode(room.id, e.target.checked, room.project_turn_budget || 100)} /><span className="tr" /></label>
          </div>
          {room.project_mode ? (
            <div className="irow">
              <span className="lab">Room budget<small>Wakes per member before pausing</small></span>
              <input className="budget-input" type="number" min="1" max="500" defaultValue={room.project_turn_budget ?? 100}
                key={`${room.id}-${room.project_turn_budget}`}
                onBlur={(e) => {
                  const next = Math.max(1, Math.min(500, Math.trunc(Number(e.target.value) || room.project_turn_budget || 100)));
                  e.target.value = String(next);
                  if (next !== room.project_turn_budget) S.handleSetProjectMode(room.id, true, next);
                }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }} />
            </div>
          ) : null}
        </div>
        {pinRow}
        <button className="danger" onClick={() => S.handleDeleteRoom(room.id)}>Delete room</button>
      </div>
    );
  }

  if (active.kind === "feed") {
    const feed = active.feed;
    return (
      <div className="info-scroll">
        <div className="hero"><ChannelMark kind="feed" size={72} /><h2>📰 {active.title}</h2><div className="sub">External news feed</div></div>
        {feed ? (
          <>
            <div className="icard">
              <div className="ihead">Source</div>
              <div className="irow"><span className="val mono" style={{ textAlign: "left", overflowWrap: "anywhere" }}>{feed.url}</span></div>
              <div className="irow"><span className="lab">Last polled</span><span className="val">{feed.last_polled_at ? relativeTime(feed.last_polled_at) : "never"}</span></div>
            </div>
            <div className="icard">
              <div className="ihead">Subscribers</div>
              {(feed.subscribers || []).map((s) => (
                <div className="irow" key={s.agent_id || s}><WireAvatar name={s.display_name || S.nameFor(s.agent_id || s)} size={32} /><span className="lab">{s.display_name || S.nameFor(s.agent_id || s)}</span></div>
              ))}
            </div>
            <button className="ghostbtn" disabled={S.feedBusy === feed.id} onClick={() => S.handlePollFeed(feed.id)}>{S.feedBusy === feed.id ? "Polling…" : "Poll now"}</button>
            <button className="danger" onClick={() => S.handleDeleteFeed(feed.id)}>Delete feed</button>
          </>
        ) : <p className="muted-note">Headlines delivered to subscribed agents as non-waking context.</p>}
        {pinRow}
      </div>
    );
  }

  return (
    <div className="info-scroll">
      <div className="hero"><ChannelMark kind="broadcast" size={72} /><h2>{active.title}</h2><div className="sub">{active.kind === "broadcast" ? "Everyone in the fleet" : "Conversation"}</div></div>
      <p className="muted-note" style={{ textAlign: "center" }}>
        {active.kind === "broadcast" ? "Messages here go to every agent at once. Each reply lands back in this thread." : "A fleet conversation."}
      </p>
      {pinRow}
    </div>
  );
}

/* ================= room modal ================= */

function WireRoomModal({ S, onClose }) {
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState([]);
  const toggle = (id) => setMemberIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  return (
    <Modal title="New room" onClose={onClose}
      actions={[
        { label: "Cancel", onClick: onClose, variant: "ghost" },
        { label: S.roomSaving ? "Creating…" : "Create room", onClick: async () => { if (!name.trim()) return; await S.handleCreateRoom(name.trim(), memberIds); onClose(); }, variant: "primary" },
      ]}>
      <p className="muted-note">A room is a named conversation with a chosen set of agents — perfect for running a project with just those teammates.</p>
      <label className="field"><span>Room name</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. API redesign" autoFocus /></label>
      <div className="field"><span>Members</span>
        <div className="mem-pick">
          {S.agents.map((a) => (
            <button key={a.id} type="button" className="mem-chip" aria-pressed={memberIds.includes(a.id)} onClick={() => toggle(a.id)}>
              <WireAvatar name={a.display_name} size={24} />{a.display_name}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/* ================= the app ================= */

export default function WireApp() {
  const S = useConsoleState();

  // --- Wire-only preferences ---
  const [theme, setTheme] = useLocalPref("ekho.theme.v1", "auto");
  const [density, setDensity] = useLocalPref("ekho.density.v1", "comfortable");
  const [pins, setPins] = useLocalPref("ekho.pins.v1", []);
  const [lastRead, setLastRead] = useLocalPref("ekho.lastread.v1", {});
  const [dmConvMap, setDmConvMap] = useLocalPref("ekho.dmconv.v1", {});
  const [bcastConv, setBcastConv] = useLocalPref("ekho.bcastconv.v1", null);

  // --- Wire-only UI state ---
  const [folder, setFolder] = useState("all");
  const [infoOpen, setInfoOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [wireRoomOpen, setWireRoomOpen] = useState(false);
  const [opsSection, setOpsSection] = useState("needs");
  const [chatSearch, setChatSearch] = useState("");

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") delete root.dataset.theme; else root.dataset.theme = theme;
    root.dataset.density = density === "compact" ? "compact" : "comfortable";
  }, [theme, density]);

  const togglePin = (key) => setPins((p) => (p.includes(key) ? p.filter((x) => x !== key) : [...p, key]));

  /* ---------- classification: the Telegram chat list ---------- */
  const agentByName = useMemo(() => {
    const m = new Map();
    for (const a of S.agents) m.set(String(a.display_name || "").toLowerCase(), a);
    return m;
  }, [S.agents]);
  const roomById = useMemo(() => new Map((S.rooms || []).map((r) => [r.id, r])), [S.rooms]);
  const convById = useMemo(() => new Map(S.conversationList.map((c) => [c.id, c])), [S.conversationList]);

  const classify = (convId) => {
    if (!convId) return null;
    if (String(convId).startsWith("feed-")) {
      const feed = (S.feeds || []).find((f) => convId === `feed-${f.id}` || convId.includes(f.id));
      return { kind: "feed", feed, title: feed ? feed.name : S.convTitle(convId) };
    }
    if (roomById.has(convId)) {
      const room = roomById.get(convId);
      return { kind: "room", room, title: `# ${room.name}` };
    }
    // Relay-truthful classification: "dm" = exactly one agent participant, so a
    // multi-agent thread whose last speaker happens to be Jarvis can never
    // masquerade as (or hijack) the Jarvis DM. Title-matching remains only as
    // the fallback for relays that predate kind/participants.
    const entry = convById.get(convId);
    if (entry?.kind === "dm" && entry.participants?.length === 1) {
      const agent = S.agents.find((a) => a.id === entry.participants[0]);
      if (agent) return { kind: "dm", agentId: agent.id, title: agent.display_name };
    }
    if (entry?.kind === "group") {
      return { kind: "thread", title: entry.title || S.convTitle(convId) || "" };
    }
    if (convId === bcastConv) return { kind: "broadcast", title: "Everyone" };
    if (entry?.kind) return { kind: "thread", title: entry.title || S.convTitle(convId) || "" };
    // Older relay without kind/participants: the old title heuristic.
    const title = S.convTitle(convId) || "";
    const agent = agentByName.get(title.toLowerCase());
    if (agent) return { kind: "dm", agentId: agent.id, title: agent.display_name };
    return { kind: "thread", title };
  };

  // Newest conversation per agent that the relay titles as a plain DM — the
  // canonical thread the strip / New-DM / topology shortcuts open, so an agent
  // with history never forks a fresh conversation.
  const newestDmByAgent = useMemo(() => {
    const m = new Map();
    for (const c of S.conversationList) {
      const cls = classify(c.id);
      if (cls?.kind === "dm" && !m.has(cls.agentId)) m.set(cls.agentId, c.id); // list is ts-desc
    }
    return m;
  }, [S.conversationList, S.rooms, S.agents, S.feeds]);
  const dmConvFor = (agentId) => newestDmByAgent.get(agentId) || dmConvMap[agentId] || null;

  const chatsAll = useMemo(() => {
    const list = [];
    const seen = new Set();
    for (const c of S.conversationList) {
      const cls = classify(c.id);
      if (!cls) continue;
      // Only the NEWEST agent-titled conversation collapses into the canonical
      // DM row; older ones stay visible as their own rows instead of vanishing.
      const canonicalDm = cls.kind === "dm" && newestDmByAgent.get(cls.agentId) === c.id;
      const key = canonicalDm ? `dm:${cls.agentId}` : cls.kind === "broadcast" ? "broadcast" : c.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const title = cls.kind === "dm" && !canonicalDm ? `${cls.title} ⋯` : cls.title;
      list.push({ key, convId: c.id, ts: c.ts, preview: c.preview, ...cls, title });
    }
    // Rooms with no recent traffic still deserve a row.
    for (const r of S.rooms || []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      list.push({ key: r.id, convId: r.id, ts: r.created_at, preview: "No messages yet", kind: "room", room: r, title: `# ${r.name}` });
    }
    // Feeds without traffic yet.
    for (const f of S.feeds || []) {
      const fid = `feed-${f.id}`;
      if (seen.has(fid) || [...seen].some((k) => String(k).startsWith("feed-") && String(k).includes(f.id))) continue;
      seen.add(fid);
      list.push({ key: fid, convId: fid, ts: f.last_polled_at || f.created_at || "", preview: "No items yet", kind: "feed", feed: f, title: f.name });
    }
    // Every agent gets a DM entry even before a thread exists.
    for (const a of S.agents) {
      const key = `dm:${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ key, convId: dmConvFor(a.id), ts: a.last_seen_at || "", preview: "No messages yet", kind: "dm", agentId: a.id, title: a.display_name });
    }
    if (!seen.has("broadcast")) {
      list.push({ key: "broadcast", convId: bcastConv, ts: "", preview: "Message every agent at once", kind: "broadcast", title: "Everyone" });
    }
    const stalledConvs = new Set((S.attention?.items || []).filter((i) => i.kind === "stalled").map((i) => i.conversationId));
    return list.map((c) => ({
      ...c,
      pinned: pins.includes(c.key),
      stalled: c.convId ? stalledConvs.has(c.convId) : false,
      unread: Boolean(c.convId && c.ts && c.ts > (lastRead[c.convId] || "") && c.convId !== S.selectedConversationId),
    }));
  }, [S.conversationList, S.rooms, S.agents, S.feeds, S.attention, pins, lastRead, S.selectedConversationId, dmConvMap, bcastConv, newestDmByAgent]);

  const chats = useMemo(() => {
    const q = chatSearch.trim().toLowerCase();
    return chatsAll
      .filter((c) => !q || c.title.toLowerCase().includes(q) || String(c.preview || "").toLowerCase().includes(q))
      .filter((c) => {
        if (folder === "agents") return c.kind === "dm";
        if (folder === "rooms") return c.kind === "room" || c.kind === "thread";
        if (folder === "feeds") return c.kind === "feed";
        return true;
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.ts).localeCompare(String(a.ts)));
  }, [chatsAll, chatSearch, folder]);

  /* ---------- active chat ---------- */
  const active = useMemo(() => {
    if (S.selectedConversationId) {
      const cls = classify(S.selectedConversationId);
      const key = cls.kind === "dm"
        ? (newestDmByAgent.get(cls.agentId) === S.selectedConversationId ? `dm:${cls.agentId}` : S.selectedConversationId)
        : cls.kind === "broadcast" ? "broadcast" : S.selectedConversationId;
      return { ...cls, key, convId: S.selectedConversationId };
    }
    // No conversation yet: derive from the composer target (fresh DM/broadcast)
    // — the send mints the conversation, so the composer must still render.
    if (S.mobileView === "chat") {
      if (S.composerRecipient === "broadcast") {
        return { kind: "broadcast", title: "Everyone", key: "broadcast", convId: null };
      }
      if (S.composerRecipient && !S.composerRecipient.startsWith("room:")) {
        const agent = S.agents.find((a) => a.id === S.composerRecipient);
        if (agent) return { kind: "dm", agentId: agent.id, title: agent.display_name, key: `dm:${agent.id}`, convId: null };
      }
    }
    return null;
  }, [S.selectedConversationId, S.composerRecipient, S.rooms, S.agents, S.feeds, S.mobileView, bcastConv, S.conversationList]);

  // Keep composer target + dm map in sync when a conversation is selected via
  // ops/trace/search rather than openChat.
  useEffect(() => {
    if (!S.selectedConversationId) return;
    const cls = classify(S.selectedConversationId);
    if (cls.kind === "room") S.setComposerRecipient(`room:${cls.room.id}`);
    else if (cls.kind === "dm") {
      S.setComposerRecipient(cls.agentId);
      setDmConvMap((m) => (m[cls.agentId] === S.selectedConversationId ? m : { ...m, [cls.agentId]: S.selectedConversationId }));
    } else if (cls.kind === "broadcast") S.setComposerRecipient("broadcast");
    // feeds: leave the recipient (composer is disabled); threads are handled by
    // the thread-target effect below so a stale room/DM target can never leak.
  }, [S.selectedConversationId, S.rooms, S.agents, S.conversationList]);

  // Unclassified threads (agent↔agent or historical broadcasts): target the
  // thread's most recent agent speaker, shown explicitly via the composer chip.
  const threadTarget = useMemo(() => {
    if (!active || active.kind !== "thread") return null;
    for (let i = S.timelineEvents.length - 1; i >= 0; i--) {
      const e = S.timelineEvents[i];
      if (e.event_type === "message.queued" && e.actor_kind === "agent" && e.actor_id && !String(e.actor_id).startsWith("op_")) {
        return e.actor_id;
      }
    }
    return null;
  }, [active?.key, active?.kind, S.timelineEvents]);
  useEffect(() => {
    if (!active || active.kind !== "thread") return;
    S.setComposerRecipient(threadTarget || "broadcast");
  }, [threadTarget, active?.key, active?.kind]);

  // A send from a fresh broadcast mints the conversation — remember it, but
  // only on the null→conversation transition so opening an unrelated thread
  // while the recipient is still "broadcast" can't be mistaken for it.
  const prevSelectedRef = useRef(S.selectedConversationId);
  useEffect(() => {
    const prev = prevSelectedRef.current;
    prevSelectedRef.current = S.selectedConversationId;
    if (!S.selectedConversationId || prev) return;
    if (S.composerRecipient === "broadcast" && S.selectedConversationId !== bcastConv) {
      const cls = classify(S.selectedConversationId);
      if (cls.kind === "thread") setBcastConv(S.selectedConversationId);
    }
  }, [S.selectedConversationId]);

  // Mark the open conversation read as new events land.
  useEffect(() => {
    const conv = S.selectedConversationId;
    if (!conv || !S.timelineEvents.length) return;
    const latest = S.timelineEvents.reduce((m, e) => (e.created_at > m ? e.created_at : m), "");
    if (latest && latest !== lastRead[conv]) setLastRead((m) => ({ ...m, [conv]: latest }));
  }, [S.timelineEvents, S.selectedConversationId]);

  function openChat(chat) {
    setBellOpen(false); setNewMenuOpen(false); setNewDmOpen(false);
    S.setOpsOpen(false);
    if (chat.kind === "room") {
      S.setComposerRecipient(`room:${chat.room.id}`);
      S.selectConversation(chat.room.id);
    } else if (chat.kind === "dm") {
      S.setComposerRecipient(chat.agentId);
      S.setSelectedAgentId(chat.agentId);
      S.refreshAgentDetail(chat.agentId).catch(() => {});
      S.refreshAgentRateLimits(chat.agentId).catch(() => {});
      if (chat.convId) S.selectConversation(chat.convId);
      else { S.setSelectedConversationId(null); S.setTimelineEvents([]); S.setMobileView("chat"); }
    } else if (chat.kind === "broadcast") {
      S.setComposerRecipient("broadcast");
      if (chat.convId) S.selectConversation(chat.convId);
      else { S.setSelectedConversationId(null); S.setTimelineEvents([]); S.setMobileView("chat"); }
    } else {
      S.selectConversation(chat.convId || chat.key);
    }
    if (chat.convId) setLastRead((m) => ({ ...m, [chat.convId]: new Date().toISOString() }));
  }

  function openDmByAgentId(agentId) {
    const a = S.agents.find((x) => x.id === agentId);
    openChat({ kind: "dm", agentId, convId: dmConvFor(agentId), title: a?.display_name || agentId });
    setInfoOpen(false);
  }

  function openFromOps(convId, agentId) {
    S.setOpsOpen(false);
    if (convId) { S.traceFromOps(convId); }
    else if (agentId) openDmByAgentId(agentId);
  }

  async function ledgerResume(convId) {
    try {
      await apiResumeConversation(S.session.token, convId);
      await Promise.all([S.refreshAttention(), S.refreshOverview()]);
      if (convId === S.selectedConversationId) await S.refreshTimeline(convId);
    } catch (error) {
      S.handleApiError(error, { allowSessionReset: true });
    }
  }

  /* ---------- composer ---------- */
  const isFeedChat = active?.kind === "feed";
  const taRef = S.composerInputRef;
  const autogrow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  };
  useEffect(() => { autogrow(); }, [S.composerText]);

  /* ---------- header data ---------- */
  const pendingApprovals = (S.approvals || []).filter((a) => a.status === "pending");
  const needsCount = (S.attention?.items?.length || 0) + pendingApprovals.length;
  const critCount = S.attention?.counts?.critical || 0;
  const fleetOk = S.fleetCounts.healthy;
  const fleetSlow = S.fleetCounts.total - S.fleetCounts.healthy - (S.fleetCounts.down || 0);
  const fleetDown = S.fleetCounts.down || 0;

  if (!S.session.token) return <WireLogin S={S} />;

  const headSub = (() => {
    if (!active) return "";
    if (active.kind === "dm") {
      const agent = S.agents.find((a) => a.id === active.agentId);
      const p = presenceOf(agent);
      return `${p === "online" ? "online" : agent?.last_seen_at ? `seen ${relativeTime(agent.last_seen_at)}` : "offline"}${agent?.metrics?.model ? ` · ${agent.metrics.model}` : ""}`;
    }
    if (active.kind === "room") return (active.room.members || []).map((m) => m.display_name).join(", ");
    if (active.kind === "feed") return "external feed · read-only";
    if (active.kind === "broadcast") return `${S.agents.length} agents`;
    return "conversation";
  })();

  return (
    <div className={`app${S.mobileView === "chat" ? " chat-open" : ""}${infoOpen && active ? " info-open" : ""}`}>
      <header className="topbar">
        <div className="brand"><span className="mark">{I.logo}</span>Ekho <small className="mono">{S.session.fleetId ? S.session.fleetId.slice(0, 12) : ""}</small></div>
        <div className="tb-search"><input type="search" placeholder="Search chats" aria-label="Search chats" value={chatSearch} onChange={(e) => setChatSearch(e.target.value)} /></div>
        <div className="tb-right">
          <div className={`fleet-pill${S.connStale ? " stale" : ""}`} title={S.connStale ? "Reconnecting — retrying every 5s" : "Fleet health"}>
            {S.connStale ? "reconnecting…" : (<>
              <i className="ok" />{fleetOk} ok
              {fleetSlow > 0 ? (<><i className="sl" />{fleetSlow} slow</>) : null}
              {fleetDown > 0 ? (<><i className="dn" />{fleetDown} down</>) : null}
            </>)}
          </div>
          <button className="tbbtn" aria-label="Needs you" aria-haspopup="true"
            onClick={() => { setBellOpen((v) => !v); setInfoOpen(false); setNewMenuOpen(false); }}>
            {I.bell}<span className={`n${critCount ? " crit" : ""}`}>{needsCount || ""}</span>
          </button>
          <button className="tbbtn" aria-label="Refresh" title="Refresh now"
            onClick={() => Promise.all([
              S.refreshOverview(), S.refreshAgents(), S.refreshAttention(), S.refreshFleetHealth(),
              S.selectedConversationId ? S.refreshTimeline() : Promise.resolve(),
            ]).catch((e) => S.handleApiError(e, { allowSessionReset: true }))}>{I.refresh}</button>
          <button className="tbbtn" aria-label={`Theme: ${theme}`} title={`Theme: ${theme} (click to cycle)`}
            onClick={() => setTheme(theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto")}>{I.theme}</button>
          <button className="tbbtn" aria-label="Settings" onClick={() => S.setSettingsOpen(true)}>{I.gear}</button>
          <button className="tbbtn" aria-label="Help" onClick={() => S.setHelpOpen(true)}>{I.help}</button>
          <button className="tbbtn" aria-label="Command deck" title="Open the Command Deck" onClick={() => window.open("#deck", "_blank", "noopener")}>{I.deck}</button>
          <button className="tbbtn" aria-label="Log out" title="Log out" onClick={S.clearStoredSession}>{I.out}</button>
        </div>
      </header>

      {bellOpen ? (
        <div className="pop" role="dialog" aria-label="Needs you">
          <div className="ph">Needs you<span className="n">{needsCount ? `${needsCount} item${needsCount === 1 ? "" : "s"}` : ""}</span></div>
          <div className="plist">
            <LedgerItems S={S} compact
              onOpenConversation={(convId, agentId) => { setBellOpen(false); openFromOps(convId, agentId); }}
              onResumeThread={(convId) => ledgerResume(convId)} />
          </div>
        </div>
      ) : null}

      <div className="main">
        <nav className="sidebar" aria-label="Chats">
          <div className="strip" role="list" aria-label="Fleet">
            {S.agents.map((a) => {
              const key = `dm:${a.id}`;
              const chat = chatsAll.find((c) => c.key === key);
              return (
                <button key={a.id} role="listitem" onClick={() => openDmByAgentId(a.id)} title={`${a.display_name} — ${a.status}`}>
                  <WireAvatar name={a.display_name} presence={presenceOf(a)} size={40} hue={S.settings.agentColors?.[a.id]} />
                  <span className="nm">{a.display_name}</span>
                  <span className="ub">{chat?.unread ? "•" : ""}</span>
                </button>
              );
            })}
          </div>
          <div className="tabs" role="tablist">
            {[["all", "All"], ["agents", "Agents"], ["rooms", "Rooms"], ["feeds", "Feeds"]].map(([key, label]) => (
              <button key={key} role="tab" className="tab" aria-selected={folder === key} onClick={() => setFolder(key)}>{label}</button>
            ))}
          </div>
          <div className="chatlist">
            {!S.initialized.current.overview ? <Skeleton count={6} height="58px" /> : null}
            {chats.some((c) => c.pinned) ? <div className="sec-label">Pinned</div> : null}
            {chats.filter((c) => c.pinned).map((c) => <ChatRow key={c.key} c={c} S={S} active={active} openChat={openChat} />)}
            {chats.some((c) => c.pinned) && chats.some((c) => !c.pinned) ? <div className="sec-label">Chats</div> : null}
            {chats.filter((c) => !c.pinned).map((c) => <ChatRow key={c.key} c={c} S={S} active={active} openChat={openChat} />)}
            {!chats.length && S.initialized.current.overview ? (
              <EmptyState title="Nothing here">No chats match this folder yet.</EmptyState>
            ) : null}
          </div>
          <div className="side-foot">
            <button className="foot-btn" onClick={() => { setNewMenuOpen((v) => !v); setNewDmOpen(false); }}>{I.plus}New chat</button>
            <button className="foot-btn" onClick={() => { S.setOpsOpen(true); setOpsSection(needsCount ? "needs" : "health"); setBellOpen(false); setInfoOpen(false); setNewMenuOpen(false); }}>
              {I.gear}Ops Center<span className="warnct">{needsCount || ""}</span>
            </button>
            {newMenuOpen ? (
              <div className="menu" role="menu">
                {newDmOpen ? (
                  <>
                    <div className="mlabel">Message an agent</div>
                    {S.agents.map((a) => (
                      <button key={a.id} role="menuitem" onClick={() => openDmByAgentId(a.id)}>
                        <WireAvatar name={a.display_name} size={26} presence={presenceOf(a)} />{a.display_name}
                      </button>
                    ))}
                    <hr />
                    <button role="menuitem" onClick={() => setNewDmOpen(false)}>{I.back}Back</button>
                  </>
                ) : (
                  <>
                    <button role="menuitem" onClick={() => setNewDmOpen(true)}>{I.dm}New direct message</button>
                    <button role="menuitem" onClick={() => { setNewMenuOpen(false); setWireRoomOpen(true); }}>{I.room}New room</button>
                    <button role="menuitem" onClick={() => { setNewMenuOpen(false); openChat({ kind: "broadcast", convId: bcastConv, title: "Everyone" }); }}>{I.bc}Broadcast to fleet</button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </nav>

        <section className="chatpane" aria-label="Conversation" {...(S.swipeBack || {})}>
          {active || S.selectedConversationId ? (
            <>
              <header className="chathead">
                <button className="backbtn" aria-label="Back to chats" onClick={S.backToList}>{I.back}</button>
                {active?.kind === "dm" ? <WireAvatar name={active.title} size={40} presence={presenceOf(S.agents.find((a) => a.id === active.agentId))} />
                  : active?.kind === "room" ? <RoomAvatar members={(active.room.members || []).map((m) => m.display_name)} size={40} />
                  : active?.kind === "feed" ? <ChannelMark kind="feed" size={40} />
                  : <ChannelMark kind="broadcast" size={40} />}
                <div className="ttl">
                  <h1>{active?.title || S.convTitle(S.selectedConversationId)}</h1>
                  <div className="sub">{headSub}</div>
                </div>
                <div className="acts">
                  {S.traceReturn ? <button className="trace-back" onClick={() => { S.setOpsOpen(true); S.returnFromTrace(); }}>↩ Ops</button> : null}
                  <label className="sysevents toggle" title="Show delivery receipts and heartbeats">
                    <input type="checkbox" checked={S.showSystem} onChange={(e) => S.setShowSystem(e.target.checked)} />system
                  </label>
                  <button className="iconbtn" aria-label="Chat details" aria-pressed={infoOpen} onClick={() => { setInfoOpen((v) => !v); setBellOpen(false); }}>{I.info}</button>
                </div>
              </header>
              <WireScroller S={S} />
              <footer className={`composer${S.dragActive ? " composer--drag" : ""}`}
                onDragOver={isFeedChat ? undefined : (e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); if (!S.dragActive) S.setDragActive(true); } }}
                onDragLeave={isFeedChat ? undefined : (e) => { if (e.currentTarget === e.target) S.setDragActive(false); }}
                onDrop={isFeedChat ? undefined : S.handleComposerDrop}>
                {isFeedChat ? (
                  <div className="notice">This is a read-only external feed — replies aren't sent anywhere. Subscribed agents receive these headlines as background context.</div>
                ) : (
                  <div className="wrap">
                    {S.dragActive ? <div className="dropveil">Drop files to attach</div> : null}
                    {active?.kind === "thread" ? (
                      <div className="reply-banner" title="This thread isn't a room or DM, so replies go to its most recent speaker">
                        <b>→ {S.composerRecipient === "broadcast" ? "Everyone" : S.nameFor(S.composerRecipient)}</b>
                        <span>replies in this thread go here</span>
                      </div>
                    ) : null}
                    {S.replyTarget ? (
                      <div className="reply-banner"><b>Replying to {S.replyTarget.label}</b><span>{S.replyTarget.text}</span>
                        <button aria-label="Cancel reply" onClick={() => S.setReplyTarget(null)}>✕</button></div>
                    ) : null}
                    {S.pendingAttachments.length || S.uploading ? (
                      <div className="pending-atts">
                        {S.pendingAttachments.map((a) => (
                          <span className="patt" key={a.id}>{a.filename}<small>{formatBytes(a.size_bytes)}</small>
                            <button aria-label={`Remove ${a.filename}`} onClick={() => S.removePendingAttachment(a.id)}>×</button></span>
                        ))}
                        {S.uploading ? <span className="patt">Uploading…</span> : null}
                      </div>
                    ) : null}
                    <div className="rowline">
                      <div className="box">
                        <button className="clip" aria-label="Attach a file"
                          disabled={S.uploading || S.pendingAttachments.length >= ATTACHMENT_MAX_PER_MESSAGE}
                          onClick={() => S.fileInputRef.current?.click()}>{I.clip}</button>
                        <input ref={S.fileInputRef} type="file" multiple accept={ATTACHMENT_ACCEPT} hidden onChange={S.handleFilePick} />
                        <textarea ref={taRef} rows={1} placeholder={`Message ${active?.title || "the fleet"}…  (@ to mention)`}
                          aria-label="Message" value={S.composerText}
                          onChange={(e) => { S.onComposerChange(e); }}
                          onKeyDown={S.onComposerKeyDown}
                          onClick={(e) => S.syncMentionMenu(e.target.value, e.target.selectionStart)}
                          onBlur={() => requestAnimationFrame(() => S.setMentionMenu(null))} />
                      </div>
                      <button className="sendbtn" aria-label={S.sending ? "Sending…" : "Send message"}
                        disabled={!S.composerText.trim() || S.sending || S.uploading} onClick={S.handleSend}>{I.send}</button>
                    </div>
                    {S.composerError ? <div className="errline">{S.composerError}</div> : null}
                    {S.mentionMenu ? (
                      <div className="mention-pop" role="listbox" aria-label="Mention an agent">
                        {S.mentionMenu.items.map((a, i) => (
                          <button key={a.agent_id} role="option" aria-selected={i === S.mentionMenu.index}
                            onMouseDown={(e) => { e.preventDefault(); S.chooseMention(a); }}>
                            <WireAvatar name={a.display_name} size={26} />{a.display_name}<small>@{a.display_name}</small>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
              </footer>
            </>
          ) : (
            <div className="msgs"><div className="msgs-inner">
              <EmptyState icon="✦" title="Pick a chat">Choose an agent, room or feed on the left — or start a new chat below.</EmptyState>
            </div></div>
          )}
        </section>

        <aside className="info" aria-label="Chat details">
          <button className="info-x" aria-label="Close details" onClick={() => setInfoOpen(false)}>{I.x}</button>
          <InfoPanel S={S} active={active} pins={pins} togglePin={togglePin} onClose={() => setInfoOpen(false)} onOpenDm={openDmByAgentId} />
        </aside>

        {S.opsOpen ? (
          <OpsCenter S={S} section={opsSection} setSection={setOpsSection}
            onClose={() => S.setOpsOpen(false)}
            onOpenConversation={openFromOps}
            onResumeThread={ledgerResume}
            needsCount={needsCount}
            density={density} setDensity={setDensity} />
        ) : null}
      </div>

      {/* ---------- modals ---------- */}
      {wireRoomOpen ? <WireRoomModal S={S} onClose={() => setWireRoomOpen(false)} /> : null}
      <WirePolicyModal S={S} />
      {S.settingsOpen ? <SettingsModal agents={S.agents} settings={S.settings} onChange={S.updateSettings} onClose={() => S.setSettingsOpen(false)} /> : null}
      {S.helpOpen ? <HelpModal onClose={() => S.setHelpOpen(false)} /> : null}
      {S.modal?.type === "alert" ? (
        <Modal title={S.modal.title} onClose={() => S.setModal(null)} actions={[{ label: "OK", onClick: () => S.setModal(null), variant: "primary" }]}>
          <p>{S.modal.message}</p>
        </Modal>
      ) : null}
      {S.modal?.type === "confirm" ? (
        <ConfirmDialog title={S.modal.title} message={S.modal.message} confirmLabel={S.modal.confirmLabel}
          confirmVariant={S.modal.confirmVariant} onConfirm={S.modal.onConfirm} onCancel={S.modal.onCancel} />
      ) : null}
      {S.modal?.type === "prompt" ? (
        <PromptDialog title={S.modal.title} message={S.modal.message} defaultValue={S.modal.defaultValue}
          onConfirm={S.modal.onConfirm} onCancel={S.modal.onCancel} />
      ) : null}

    </div>
  );
}

/* ---------- chat row ---------- */

function ChatRow({ c, S, active, openChat }) {
  const isActive = active?.key === c.key;
  const previewName = c.kind === "dm" || c.kind === "feed" ? null : null;
  return (
    <button className="row" aria-current={isActive} onClick={() => openChat(c)}>
      {c.kind === "dm" ? (
        <WireAvatar name={c.title} size={46} presence={presenceOf(S.agents.find((a) => a.id === c.agentId))} />
      ) : c.kind === "room" ? (
        <RoomAvatar members={(c.room?.members || []).map((m) => m.display_name)} size={46} />
      ) : c.kind === "feed" ? (
        <ChannelMark kind="feed" size={46} />
      ) : (
        <ChannelMark kind="broadcast" size={46} />
      )}
      <span className="who">
        <span className="nm">{c.pinned ? I.pin : null}{c.title}</span>
        <span className="pv">{previewName ? <span className="sender">{previewName}: </span> : null}{c.preview || "No messages yet"}</span>
      </span>
      <span className="meta">
        <span>{c.ts ? relativeTime(c.ts) : ""}</span>
        {c.stalled ? <span className="ub stall">⏸</span> : c.unread ? <span className="ub hot">●</span> : null}
      </span>
    </button>
  );
}
