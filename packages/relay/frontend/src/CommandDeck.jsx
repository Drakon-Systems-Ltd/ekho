import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadSession, getTopology, getActivity, controlAgent, setAgentTrust, setPeerAutoreply, sendOperatorMessage } from "./api";
import "./deck.css";

const POLL_MS = 5000;
const C = 500, R = 480; // radar scope centre + radius (viewBox 0 0 1000 1000)
const VIEWS = ["radar", "ops", "intel"];

/* ---------- helpers ---------- */
function parsePayload(raw) {
  if (!raw) return {};
  if (typeof raw !== "string") return raw || {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}
function clockOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
}
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const viewFromHash = () => { const m = (window.location.hash || "").match(/^#deck\/(radar|ops|intel)/); return m ? m[1] : "radar"; };

// Plot agents radially: stable angle by sorted id, radius pulled toward the core
// by recent throughput (busy units engage near command).
function plotAgents(nodes) {
  const sorted = [...(nodes || [])].sort((a, b) => (a.id < b.id ? -1 : 1));
  const n = sorted.length || 1;
  const maxT = Math.max(1, ...sorted.map((a) => (a.sent_1h || 0) + (a.received_1h || 0)));
  return sorted.map((a, i) => {
    const tput = (a.sent_1h || 0) + (a.received_1h || 0);
    const angle = (-90 + (i * 360) / n) * (Math.PI / 180);
    const range = 0.78 - 0.3 * (tput / maxT);
    const healthy = a.status === "healthy" || a.status === "active";
    const alert = a.status === "quarantined" || a.status === "revoked";
    const warn = !healthy && !alert;
    const isC = (a.runtime || "") !== "openclaw";
    const tone = warn || alert ? "warn" : isC ? "c" : "gold";
    return {
      ...a, tput, tone, alert,
      model: a.metrics?.model || "",
      x: C + range * R * Math.cos(angle), y: C + range * R * Math.sin(angle),
      px: 50 + range * 48 * Math.cos(angle), py: 50 + range * 48 * Math.sin(angle),
    };
  });
}

function useStaticScope() {
  return useMemo(() => {
    const els = [];
    els.push(<defs key="d"><clipPath id="dk-rclip"><circle cx={C} cy={C} r="478" /></clipPath></defs>);
    const floor = []; const size = 30, dx = 1.5 * size, dy = Math.sqrt(3) * size; let k = 0;
    for (let col = -1; col * dx < 1060; col++) for (let row = -1; row * dy < 1080; row++) {
      const cx = col * dx, cy = row * dy + (col % 2 ? dy / 2 : 0); const pts = [];
      for (let j = 0; j < 6; j++) { const a = j * Math.PI / 3; pts.push((cx + size * Math.cos(a)).toFixed(1) + "," + (cy + size * Math.sin(a)).toFixed(1)); }
      const dist = Math.hypot(cx - C, cy - C);
      floor.push(<polygon key={"h" + k++} points={pts.join(" ")} fill="none" stroke={dist < 200 ? "rgba(255,30,60,0.10)" : "rgba(255,90,24,0.055)"} strokeWidth="1" />);
    }
    els.push(<g key="floor" clipPath="url(#dk-rclip)">{floor}</g>);
    [478, 358, 239, 119].forEach((r, i) => els.push(<circle key={"r" + i} cx={C} cy={C} r={r} fill="none" stroke={i === 0 ? "rgba(255,120,20,0.30)" : "rgba(255,90,24,0.13)"} strokeWidth={i === 0 ? 1.4 : 1} />));
    els.push(<circle key="dash" cx={C} cy={C} r="414" fill="none" stroke="rgba(255,30,60,0.16)" strokeWidth="1" strokeDasharray="3 7" />);
    els.push(<line key="cv" x1={C} y1="24" x2={C} y2="976" stroke="rgba(255,90,24,0.10)" />);
    els.push(<line key="ch" x1="24" y1={C} x2="976" y2={C} stroke="rgba(255,90,24,0.10)" />);
    const bez = [];
    for (let a = 0; a < 360; a += 5) {
      const rad = (a - 90) * Math.PI / 180, big = a % 30 === 0, card = a % 90 === 0, r1 = big ? 456 : 470;
      bez.push(<line key={"b" + a} x1={C + r1 * Math.cos(rad)} y1={C + r1 * Math.sin(rad)} x2={C + 480 * Math.cos(rad)} y2={C + 480 * Math.sin(rad)} stroke={card ? "#ff1e3c" : big ? "#ffb400" : "rgba(255,120,20,0.35)"} strokeWidth={card ? 2 : big ? 1.6 : 1} />);
      if (big) bez.push(<text key={"t" + a} x={C + 438 * Math.cos(rad)} y={C + 438 * Math.sin(rad)} fill={card ? "rgba(255,30,60,0.7)" : "rgba(255,120,20,0.55)"} fontSize="13" fontFamily="Share Tech Mono" textAnchor="middle" dominantBaseline="middle">{String(a).padStart(3, "0")}</text>);
    }
    els.push(<g key="bez">{bez}</g>);
    return els;
  }, []);
}

function intelLine(e, nameOf) {
  const p = parsePayload(e.payload_json || e.payload);
  const t = e.event_type || "";
  const who = e.actor_kind === "operator" ? "Operator" : e.actor_name || nameOf(e.actor_id) || e.actor_id || "system";
  let tag = "EVT", cls = "", text = t.replace(/\./g, " · ");
  if (t === "message.queued") {
    const rk = p.recipient_kind;
    tag = rk === "broadcast" ? "CAST" : rk === "room" ? "ROOM" : "MSG";
    const to = rk === "broadcast" ? "the fleet" : rk === "room" ? "a room" : nameOf(p.recipient_id) || "a teammate";
    text = "→ " + to + (p.text ? " — “" + trunc(p.text, 78) + "”" : "");
  } else if (t === "message.acked") { tag = "ACK"; text = "acknowledged a message"; }
  else if (t === "message.delivered") { tag = "RCV"; text = "received a message"; }
  else if (t.startsWith("room.")) { tag = "ROOM"; text = t === "room.created" ? "created a room" : "room update"; }
  else if (t === "agent.trust_changed") { tag = "TRUST"; text = "operator trust " + (p.operator_trusted ? "ON" : "OFF"); }
  else if (t === "agent.peer_autoreply_changed") { tag = "DLG"; text = "delegation " + (p.peer_autoreply ? "ON · budget " + p.peer_turn_budget : "OFF"); }
  else if (t.includes("quarantine")) { tag = "ALERT"; cls = "--a"; text = "quarantined" + (p.reason ? " — " + p.reason : ""); }
  else if (t === "agent.pause") { tag = "PAUSE"; cls = "--w"; text = "paused"; }
  else if (t === "agent.resume") { tag = "RESUME"; text = "resumed"; }
  else if (t === "feed.delivered") { tag = "FEED"; text = "feed delivered" + (p.feed ? " · " + p.feed : ""); }
  else if (t.startsWith("approval")) { tag = "APPR"; text = "approval " + t.replace("approval.", ""); }
  else if (t === "message.expired") { tag = "EXP"; cls = "--w"; text = "message expired"; }
  return { time: clockOf(e.created_at), who, text, tag, cls };
}

/* ---------- component ---------- */
export default function CommandDeck() {
  const session = loadSession();
  const [topo, setTopo] = useState({ nodes: [], edges: [], window_minutes: 60 });
  const [activity, setActivity] = useState([]);
  const [view, setView] = useState(viewFromHash);
  const [now, setNow] = useState(Date.now());
  const [bearing, setBearing] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(""); // `${agentId}:${action}`
  const [tracers, setTracers] = useState([]);
  const [hail, setHail] = useState("");
  const [hailState, setHailState] = useState(""); // "", "sending", "sent", "error"
  const seenRef = useRef(null);
  const staticScope = useStaticScope();

  // clock + decorative bearing
  useEffect(() => {
    const t = setInterval(() => { setNow(Date.now()); setBearing((b) => (b + 13) % 360); }, 1000);
    return () => clearInterval(t);
  }, []);

  // keep view in sync with the hash (deep-linkable pages, one per monitor)
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const selectView = (v) => { setView(v); if (window.location.hash !== "#deck/" + v) window.location.hash = "deck/" + v; };

  const pull = useCallback(async () => {
    if (!session.token) return;
    try {
      const [tp, ac] = await Promise.all([getTopology(session.token), getActivity(session.token, { limit: 40 })]);
      setTopo({ nodes: tp.nodes || [], edges: tp.edges || [], window_minutes: tp.window_minutes || 60 });
      setActivity(ac.events || []);
    } catch { /* transient; keep last good */ }
  }, [session.token]);

  useEffect(() => {
    if (!session.token) return;
    let live = true;
    const run = () => { if (live) pull(); };
    run();
    const t = setInterval(run, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [session.token, pull]);

  const agents = useMemo(() => plotAgents(topo.nodes), [topo.nodes]);
  const posById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const nameById = useMemo(() => new Map((topo.nodes || []).map((a) => [a.id, a.display_name || a.id])), [topo.nodes]);
  const nameOf = (id) => (id ? nameById.get(id) || id : null);
  const selected = useMemo(() => agents.find((a) => a.id === selectedId) || null, [agents, selectedId]);

  // Live message tracers — fire a glowing dot along the radar link whenever a NEW
  // message is sent between agents. Backlog is seeded silently on first load.
  useEffect(() => {
    if (!activity.length) return;
    if (seenRef.current === null) { seenRef.current = new Set(activity.map((e) => e.id)); return; }
    const fresh = activity.filter((e) => !seenRef.current.has(e.id));
    activity.forEach((e) => seenRef.current.add(e.id));
    const added = [];
    fresh.filter((e) => e.event_type === "message.queued").forEach((e) => {
      const p = parsePayload(e.payload_json);
      const src = posById.get(e.actor_id) || { x: C, y: C };
      const rk = p.recipient_kind;
      let targets;
      if (rk === "broadcast") targets = agents.filter((a) => a.id !== e.actor_id);
      else if (p.recipient_id && posById.get(p.recipient_id)) targets = [posById.get(p.recipient_id)];
      else targets = [{ x: C, y: C }];
      targets.forEach((t, i) => added.push({ id: e.id + "-" + i, x1: src.x, y1: src.y, x2: t.x, y2: t.y, c: src.tone === "c" }));
    });
    if (added.length) {
      setTracers((prev) => [...prev, ...added].slice(-40));
      const ids = new Set(added.map((a) => a.id));
      setTimeout(() => setTracers((prev) => prev.filter((t) => !ids.has(t.id))), 1500);
    }
  }, [activity, posById, agents]);

  // derived stats
  const online = agents.filter((a) => a.tone !== "warn").length;
  const alerts = agents.filter((a) => a.alert).length;
  const msgHr = (topo.nodes || []).reduce((s, a) => s + (a.received_1h || 0), 0);
  const trusted = (topo.nodes || []).filter((a) => a.operator_trusted).length;
  const hours = (topo.window_minutes || 60) / 60;
  const exit = () => { window.location.hash = ""; };

  // actions
  const doControl = async (id, action) => {
    setBusy(id + ":" + action);
    try { await controlAgent(session.token, id, action, { reason: "command deck" }); await pull(); } catch { /* ignore */ } finally { setBusy(""); }
  };
  const doTrust = async (a) => {
    setBusy(a.id + ":trust");
    try { await setAgentTrust(session.token, a.id, !a.operator_trusted); await pull(); } catch { /* ignore */ } finally { setBusy(""); }
  };
  const doDelegation = async (a) => {
    setBusy(a.id + ":dlg");
    try { await setPeerAutoreply(session.token, a.id, !a.peer_autoreply); await pull(); } catch { /* ignore */ } finally { setBusy(""); }
  };
  const sendHail = async () => {
    if (!selected || !hail.trim()) return;
    setHailState("sending");
    try { await sendOperatorMessage(session.token, { recipientAgentId: selected.id, text: hail.trim() }); setHail(""); setHailState("sent"); setTimeout(() => setHailState(""), 2600); await pull(); }
    catch { setHailState("error"); }
  };

  if (!session.token) {
    return (
      <div className="cmd-deck">
        <div className="atmos atmos--glowtop" /><div className="atmos atmos--vig" />
        <div className="gate"><div>
          <div className="brand__name" style={{ marginBottom: 12 }}>EKHO · COMMAND DECK</div>
          <p className="mono" style={{ color: "var(--muted)" }}>NO SESSION. <a href="#">Open the console</a> and log in, then return here.</p>
        </div></div>
      </div>
    );
  }

  const initials = (a) => (a.display_name || a.id).slice(0, 2).toUpperCase();
  const NAME = (a) => (a.display_name || a.id).toUpperCase();

  const Roster = (
    <section className="panel reveal d1">
      <div className="panel__cap"><span className="panel__title">FLEET ROSTER</span><span className="panel__tag">{agents.length} UNITS</span></div>
      <div className="panel__body">
        {agents.length ? [...agents].sort((a, b) => NAME(a).localeCompare(NAME(b))).map((a) => {
          const maxT = Math.max(1, ...agents.map((x) => x.tput));
          return (
            <button className={`unit unitbtn ${a.tone === "c" ? "c" : a.tone === "warn" ? "warn" : ""}${selectedId === a.id ? " sel" : ""}`} key={a.id} onClick={() => setSelectedId(a.id)}>
              <div className={`hexframe ${a.tone === "c" ? "c" : ""}`}><span>{initials(a)}</span></div>
              <div><div className="unit__name">{NAME(a)}</div><div className="unit__meta">{(a.runtime || "custom").toUpperCase()} · <b>{a.model || "model —"}</b></div></div>
              <div className="unit__stat">
                <span className="unit__dot" />
                <div className="unit__tput">{a.sent_1h || 0}↑ {a.received_1h || 0}↓</div>
                <div className="bar"><i style={{ width: Math.round(8 + 92 * (a.tput / maxT)) + "%" }} /></div>
              </div>
            </button>
          );
        }) : <div className="mono" style={{ color: "var(--muted)", padding: 8 }}>ACQUIRING UNITS…</div>}
      </div>
    </section>
  );

  const Radar = (
    <section className="panel radarwrap reveal d2">
      <div className="radar__cap"><span>SECTOR <b>FLEET</b></span><span>BEARING <b>{String(bearing).padStart(3, "0")}°</b> · SWEEP <b>ACTIVE</b></span></div>
      <div className="radar">
        <svg className="scope" viewBox="0 0 1000 1000">
          {staticScope}
          <g>{agents.map((a) => <line key={"sp" + a.id} x1={C} y1={C} x2={a.x} y2={a.y} stroke="rgba(255,120,20,0.16)" strokeWidth="1" />)}</g>
          <g>{topo.edges.map((e, i) => {
            const s = posById.get(e.source), t = posById.get(e.target);
            if (!s || !t) return null;
            return <line key={"lk" + i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke="#ff1e3c" strokeWidth={1.2 + Math.min(e.count, 8) * 0.25} strokeDasharray="5 6" opacity="0.55">
              <animate attributeName="stroke-dashoffset" from="0" to="-22" dur="1.2s" repeatCount="indefinite" /></line>;
          })}</g>
          {selected ? <circle cx={selected.x} cy={selected.y} r="26" fill="none" stroke={selected.tone === "c" ? "#ff6a52" : "#ffe08a"} strokeWidth="1.5" strokeDasharray="3 4"><animateTransform attributeName="transform" type="rotate" from={`0 ${selected.x} ${selected.y}`} to={`360 ${selected.x} ${selected.y}`} dur="8s" repeatCount="indefinite" /></circle> : null}
          {tracers.map((tr) => (
            <circle key={tr.id} r="5.5" fill={tr.c ? "#ff5a4a" : "#ffe08a"} style={{ filter: `drop-shadow(0 0 7px ${tr.c ? "#ff1e3c" : "#ffb400"})` }}>
              <animate attributeName="cx" from={tr.x1} to={tr.x2} dur="1.3s" fill="freeze" />
              <animate attributeName="cy" from={tr.y1} to={tr.y2} dur="1.3s" fill="freeze" />
              <animate attributeName="opacity" values="0;1;1;0" dur="1.3s" fill="freeze" />
            </circle>
          ))}
          {[[358, 0.75], [239, 0.5], [119, 0.25]].map(([r, f]) => <text key={"rl" + r} x={C} y={C - r - 6} fill="var(--muted)" fontSize="12" fontFamily="Share Tech Mono" textAnchor="middle">{(f * hours).toFixed(2)}h</text>)}
        </svg>
        <div className="sweep" /><div className="ping" />
        <div className="nanoring">{Array.from({ length: 12 }).map((_, i) => <div key={i} className={"nanocell" + (i % 3 === 0 ? " c" : "")} style={{ transform: `rotate(${i * 30}deg) translateY(-150%)`, animationDelay: (i * 0.13).toFixed(2) + "s" }} />)}</div>
        <div className="core">
          <div className="core__glow" />
          <svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="46" fill="none" stroke="#ffb400" strokeWidth="1.4" opacity="0.9" />
            <circle cx="50" cy="50" r="38" fill="none" stroke="#ff6a52" strokeWidth="0.8" strokeDasharray="2 3" opacity="0.8" className="bezel-rot" />
            <polygon points="50,18 77,64 23,64" fill="none" stroke="#fff3da" strokeWidth="2.4" strokeLinejoin="round" style={{ filter: "drop-shadow(0 0 6px #ff5a18)" }} />
            <polygon points="50,30 67,59 33,59" fill="rgba(255,235,200,0.2)" stroke="#ffb400" strokeWidth="1" />
            <circle cx="50" cy="50" r="6" fill="#fff6e6" />
          </svg>
          <div className="core__label">EKHO · RELAY ONLINE</div>
        </div>
        <div>{agents.map((a) => (
          <button className={"blip blipbtn" + (a.tone === "c" ? " blip--c" : a.tone === "warn" ? " blip--warn" : "") + (selectedId === a.id ? " sel" : "")} key={a.id} style={{ left: a.px + "%", top: a.py + "%" }} onClick={() => setSelectedId(a.id)}>
            <div className="blip__dot" />
            <div className="blip__label"><div className="blip__name">{NAME(a)}</div><div className="blip__sub">{(a.runtime || "custom")} · {a.model || "—"}</div></div>
          </button>
        ))}</div>
      </div>
      <div className="radar__foot"><span>UNITS <b>{agents.length}</b></span><span>LINKS <b>{topo.edges.length}</b></span><span>RANGE <b>{hours.toFixed(1)}h</b> · WINDOW <b>{topo.window_minutes}m</b></span></div>
    </section>
  );

  const ctlBtn = (a, action, label, kind) => (
    <button className={"ctl ctl--" + kind} disabled={busy === a.id + ":" + action} onClick={() => doControl(a.id, action)}>{busy === a.id + ":" + action ? "…" : label}</button>
  );

  const Ops = (
    <section className="panel reveal d2">
      <div className="panel__cap"><span className="panel__title">UNIT OPS</span><span className="panel__tag">{agents.length} UNITS · {trusted} TRUSTED</span></div>
      <div className="opsgrid">
        {agents.map((a) => (
          <div className={"opscard" + (a.tone === "c" ? " c" : "") + (a.alert ? " alert" : "")} key={a.id}>
            <button className="opscard__h" onClick={() => setSelectedId(a.id)}>
              <div className={`hexframe ${a.tone === "c" ? "c" : ""}`}><span>{initials(a)}</span></div>
              <div><div className="opscard__name">{NAME(a)}</div><div className="opscard__rt">{(a.runtime || "custom").toUpperCase()} · <span className="opscard__model">{a.model || "model —"}</span></div></div>
            </button>
            <div className="opscard__row"><span>STATUS</span><b style={{ color: a.tone === "warn" ? "var(--ember)" : undefined }}>{(a.status || "—").toUpperCase()}</b></div>
            <div className="opscard__row"><span>THROUGHPUT 1H</span><b>{a.sent_1h || 0}↑ {a.received_1h || 0}↓</b></div>
            <div className="opscard__row"><span>ACTIVE CONV</span><b>{a.active_conversations?.length || 0}</b></div>
            <div className="flags">
              {a.operator_trusted ? <span className="flag">TRUSTED</span> : null}
              {a.peer_autoreply ? <span className="flag flag--c">DELEGATION · {a.peer_turn_budget}</span> : <span className="flag">SOLO</span>}
            </div>
            <div className="ctlrow">
              {a.status === "healthy" || a.status === "active"
                ? <>{ctlBtn(a, "pause", "PAUSE", "warn")}{ctlBtn(a, "quarantine", "QUARANTINE", "danger")}</>
                : ctlBtn(a, "resume", a.status === "quarantined" ? "RELEASE" : "RESUME", "ok")}
              <button className="ctl ctl--hail" onClick={() => setSelectedId(a.id)}>HAIL ▸</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );

  const intelRows = activity.map((e) => ({ e, f: intelLine(e, nameOf) }));
  const feed = (rows) => rows.map(({ e, f }) => (
    <div className="feedrow" key={e.id}>
      <span className="feedrow__t">{f.time}</span>
      <span className="feedrow__txt"><b>{f.who}</b> {f.text}</span>
      <span className={"tagchip" + (f.cls ? " tagchip" + f.cls : "")}>{f.tag}</span>
    </div>
  ));
  const Intel = (
    <section className="panel reveal d3">
      <div className="panel__cap"><span className="panel__title">INTEL STREAM</span><span className="panel__tag">LIVE</span></div>
      <div className="intel-cap">
        <div className="minibar"><div className="minibar__l">MSG / HR</div><div className="minibar__v">{msgHr}</div></div>
        <div className="minibar c"><div className="minibar__l">LINKS</div><div className="minibar__v">{topo.edges.length}</div></div>
        <div className="minibar"><div className="minibar__l">TRUSTED</div><div className="minibar__v">{trusted}</div></div>
      </div>
      <div className="panel__body">{intelRows.length ? feed(intelRows) : <div className="mono" style={{ color: "var(--muted)", padding: 8 }}>NO ACTIVITY IN WINDOW.</div>}</div>
    </section>
  );
  const IntelBoard = (
    <section className="panel reveal d2">
      <div className="panel__cap"><span className="panel__title">COMMS LOG</span><span className="panel__tag">{intelRows.length} EVENTS</span></div>
      <div className="panel__body" style={{ columnWidth: 360, columnGap: 18 }}>
        {intelRows.map(({ e, f }) => (
          <div className="feedrow" key={e.id} style={{ breakInside: "avoid" }}>
            <span className="feedrow__t">{f.time}</span>
            <span className="feedrow__txt"><b>{f.who}</b> {f.text}</span>
            <span className={"tagchip" + (f.cls ? " tagchip" + f.cls : "")}>{f.tag}</span>
          </div>
        ))}
      </div>
    </section>
  );

  const Dossier = selected && (
    <aside className="dossier reveal">
      <div className="dossier__cap">
        <div className="dossier__id">
          <div className={`hexframe ${selected.tone === "c" ? "c" : ""}`}><span>{initials(selected)}</span></div>
          <div><div className="dossier__name">{NAME(selected)}</div><div className="dossier__rt mono">{(selected.runtime || "custom").toUpperCase()} · {selected.model || "model —"}</div></div>
        </div>
        <button className="exit" onClick={() => setSelectedId("")}>✕</button>
      </div>
      <div className="dossier__body">
        <div className="dossier__stats">
          <div><span className="minibar__l">STATUS</span><div className="dossier__stat" style={{ color: selected.tone === "warn" ? "var(--ember)" : "var(--gold-hi)" }}>{(selected.status || "—").toUpperCase()}</div></div>
          <div><span className="minibar__l">1H THRU</span><div className="dossier__stat">{selected.sent_1h || 0}↑ {selected.received_1h || 0}↓</div></div>
          <div><span className="minibar__l">CONV</span><div className="dossier__stat">{selected.active_conversations?.length || 0}</div></div>
          <div><span className="minibar__l">BEAT</span><div className="dossier__stat">{selected.last_heartbeat_at ? clockOf(selected.last_heartbeat_at) : "—"}</div></div>
        </div>
        <div className="dossier__controls">
          {selected.status === "healthy" || selected.status === "active"
            ? <>{ctlBtn(selected, "pause", "PAUSE", "warn")}{ctlBtn(selected, "quarantine", "QUARANTINE", "danger")}</>
            : ctlBtn(selected, "resume", selected.status === "quarantined" ? "RELEASE" : "RESUME", "ok")}
          <button className={"ctl ctl--" + (selected.operator_trusted ? "ok" : "ghost")} disabled={busy === selected.id + ":trust"} onClick={() => doTrust(selected)}>{busy === selected.id + ":trust" ? "…" : selected.operator_trusted ? "TRUSTED ✓" : "TRUST"}</button>
          <button className={"ctl ctl--" + (selected.peer_autoreply ? "ok" : "ghost")} disabled={busy === selected.id + ":dlg"} onClick={() => doDelegation(selected)}>{busy === selected.id + ":dlg" ? "…" : selected.peer_autoreply ? "DELEGATION ✓" : "DELEGATION"}</button>
        </div>
        <div className="hailbox">
          <div className="minibar__l">HAIL UNIT</div>
          <textarea className="hailbox__in" rows={2} placeholder={`Message ${NAME(selected)}…`} value={hail} onChange={(e) => setHail(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendHail(); } }} />
          <button className="ctl ctl--hail hailbox__send" disabled={!hail.trim() || hailState === "sending"} onClick={sendHail}>
            {hailState === "sending" ? "TRANSMITTING…" : hailState === "sent" ? "TRANSMITTED ✓" : hailState === "error" ? "FAILED — RETRY" : "◂ TRANSMIT HAIL"}
          </button>
        </div>
        <div className="dossier__log">
          <div className="minibar__l" style={{ marginBottom: 6 }}>UNIT COMMS</div>
          {intelRows.filter(({ e }) => e.actor_id === selected.id || parsePayload(e.payload_json).recipient_id === selected.id).slice(0, 8).map(({ e, f }) => (
            <div className="feedrow" key={e.id}><span className="feedrow__t">{f.time}</span><span className="feedrow__txt">{f.text}</span><span className={"tagchip" + (f.cls ? " tagchip" + f.cls : "")}>{f.tag}</span></div>
          ))}
        </div>
      </div>
    </aside>
  );

  const center = view === "ops" ? Ops : view === "intel" ? IntelBoard : Radar;

  return (
    <div className="cmd-deck">
      <div className="atmos atmos--glowtop" />
      <div className="atmos atmos--grid" />
      <div className="atmos atmos--scan" />
      <div className="atmos atmos--vig" />
      <div className="bootscan" />
      <div className="nanofield">{Array.from({ length: 30 }).map((_, i) => <i key={i} className={i % 3 === 0 ? "c" : ""} style={{ left: ((i * 53) % 100) + "%", top: (58 + (i * 37) % 42) + "%", animationDuration: (6 + (i % 7) * 1.4).toFixed(1) + "s", animationDelay: (-(i % 12)).toFixed(1) + "s" }} />)}</div>

      <div className="deck">
        <header className="topbar">
          <div className="brand">
            <div className="brand__mark" />
            <div><div className="brand__name">EKHO</div><div className="brand__sub mono">COMMAND DECK · FLT-██████</div></div>
          </div>
          <nav className="modes">
            {[["radar", "◎ RADAR"], ["ops", "▦ OPS"], ["intel", "⊟ INTEL"]].map(([v, label]) => (
              <button key={v} className={"mode" + (view === v ? " mode--on" : "")} onClick={() => selectView(v)}>{label}</button>
            ))}
          </nav>
          <div className="status">
            <div className="pill pill--ok"><span className="unit__dot" /> FLEET <b>{online}/{agents.length} ONLINE</b></div>
            <div className={"pill " + (alerts ? "pill--alert" : "")}>ALERTS <b>{alerts}</b></div>
            <div className="clock">{new Date(now).toLocaleTimeString("en-GB")}</div>
            <button className="exit" onClick={exit}>EXIT ▸</button>
          </div>
        </header>

        <div className={"main" + (selected ? " main--dossier" : "")}>
          {Roster}
          {center}
          {Intel}
          {Dossier}
        </div>

        <footer className="footbar">
          <span>SYS <b style={{ color: alerts ? "var(--crim-hi)" : undefined }}>{alerts ? "ALERT" : "NOMINAL"}</b></span>
          <span>UNITS <b>{agents.length}</b></span>
          <span>WINDOW <b>{topo.window_minutes}m</b></span>
          <span className="grow tick"><span>{`// ${online}/${agents.length} UNITS REPORTING · ${topo.edges.length} ACTIVE LINKS · ${alerts} ALERTS · ${trusted} TRUSTED · DELEGATION BOUNDED · SECTOR NOMINAL ${"  "}`.repeat(2)}</span></span>
          <span>THRPT <b>{msgHr}/h</b></span>
        </footer>
      </div>
    </div>
  );
}
