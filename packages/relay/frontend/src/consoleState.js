// consoleState.js — the operator console's entire state/logic layer, extracted
// from App.jsx verbatim so multiple render layers (the classic console, the
// Wire redesign) can share one behavior. Pure data + handlers: nothing in this
// file renders JSX. Render-only pieces (ChatScroller, modals, tabs) stay with
// their renderer.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  clearSession,
  controlAgent,
  createPolicy,
  deletePolicy,
  getAgentDetail,
  getAgentRateLimits,
  getAgents,
  getApprovals,
  getConversationEvents,
  getDeadLetterDetail,
  getDeadLetters,
  getOverview,
  getPolicies,
  issueEnrollmentToken,
  loadSession,
  login,
  resolveApproval,
  sendOperatorMessage,
  getFleetHealth,
  getAttention,
  getTopology,
  getActivity,
  getRooms,
  createRoom,
  deleteRoom,
  setRoomProjectMode,
  resumeConversation,
  getFeeds,
  createFeedSource,
  deleteFeedSource,
  setFeedSubscribers,
  pollFeedSource,
  setAgentTrust,
  setPeerAutoreply,
  storeSession,
  updatePolicy,
  uploadOperatorAttachment,
} from "./api";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  formatBytes,
  isAllowedAttachmentMime,
  loadSettings,
  resolveAttachmentMime,
  saveSettings,
} from "./components";
import { useAutoRefresh, useEdgeSwipeBack, useNow } from "./hooks";
import { reconcileOptimistic } from "./optimistic.js";
import { resolveOutgoingConversationId } from "./compose.js";
import { isConnectionStale } from "./connection.js";
import { getUnlocked } from "./operatorKeyStore.js";
import { buildOperatorCanonical, signCanonical, randomNonce } from "./operatorKey.js";
import { mentionContext, insertMention, parseMentions, filterAgents } from "./mentions.js";

// Shared pure display helpers live in components.jsx; re-export them here so
// both renderers can import everything logic-adjacent from one place.
export { clockTime, colorForAgent, colorForId, relativeTime } from "./components";

export const POLL_INTERVAL_MS = 5000;
export const TIMELINE_LIMIT = 100;

// Window in which an incoming agent message animates (typewriter reveal).
export const NEW_MESSAGE_MS = 45_000;

// Short labels for the right-rail Ops tabs, used by the mobile "back to where you
// were" breadcrumb when a chat was opened by tracing from one of them.
export const RAIL_TAB_LABELS = {
  approvals: "Approvals",
  health: "Health",
  topology: "Map",
  activity: "Activity",
  feeds: "Feeds",
  agent: "Agent",
  access: "Access",
  deadletters: "Dead letters",
  policies: "Policies",
};

/* Map a raw conversation event into a renderable chat item. Operator messages
   carry their text in the event payload; agent/system events are rendered as
   readable activity lines derived from the event type + payload. */
export function describeEvent(event) {
  const payload = parsePayload(event.payload_json);
  const type = event.event_type || "";
  const isOperator = event.actor_kind === "operator" || payload.sender_label === "Operator";
  const isMessage = type === "message.queued";
  // Feed items (rendered from messages by getFeedConversation) — a one-way news
  // stream, labelled by the feed name rather than an agent/operator.
  const isFeed = isMessage && (event.actor_kind === "feed" || payload.message_type === "feed");
  const feedName = isFeed ? (payload.feed || "Feed") : undefined;
  // Bounded-delegation lifecycle: rendered as timeline chips, with a Resume
  // button on the stall so a budget-paused thread is one click from moving.
  const isStalled = type === "conversation.stalled";
  const isResumed = type === "conversation.resumed";
  const isSystem = !isMessage && (isStalled || isResumed || event.actor_kind === "system" || /^(approval|policy|agent)\./.test(type));

  // Prefer the real message body (attached by the API for agent + operator
  // sends) so agent messages render as actual chat bubbles, not activity lines.
  const messageBody = parsePayload(event.message_body_json);
  let text;
  if (isMessage && payload.text) {
    text = payload.text;
  } else if (isMessage && typeof messageBody.text === "string" && messageBody.text.trim()) {
    text = messageBody.text;
  } else if (isMessage) {
    const to = payload.recipient_id || event.message_recipient_id || (payload.recipient_kind === "broadcast" || event.message_recipient_kind === "broadcast" ? "broadcast" : "—");
    text = `Sent a ${payload.message_type || "message"} → ${to}`;
  } else {
    text = humanizeEvent(type, payload);
  }

  const recipientKind = payload.recipient_kind || event.message_recipient_kind || "";
  const recipientId = payload.recipient_id || event.message_recipient_id || "";

  // Attachment metadata (never bytes) stitched onto message events by the relay's
  // getConversation. Surface it so the bubble can render thumbnails/chips.
  const attachments = isMessage && Array.isArray(event.message_attachments) ? event.message_attachments : [];

  return {
    // The event's own primary key — a stable, unique React key for the timeline
    // row (immune to list reordering across polls).
    id: event.id,
    kind: isSystem ? "system" : "message",
    side: isOperator ? "operator" : "agent",
    variant: isStalled ? "stalled" : isResumed ? "resumed" : undefined,
    // Budget that ran out (stall chips only) — the chip renderer words the line.
    stallBudget: isStalled ? payload.budget ?? null : undefined,
    feed: isFeed,
    feedName,
    senderId: event.actor_id || "system",
    // Display name is resolved later from the live agents map; fall back to the id.
    senderLabel: isOperator ? "Operator" : event.actor_id || "system",
    messageId: event.resource_kind === "message" ? event.resource_id || "" : "",
    recipientKind,
    recipientId,
    text,
    attachments,
    // Operator messages carry an Ed25519 signature when an operator key is
    // unlocked; surface it for the signal-log verification glyph.
    signed: Boolean(payload.operator_sig),
    type,
    createdAt: event.created_at,
  };
}

export function humanizeEvent(type, payload) {
  switch (type) {
    case "approval.requested":
      return `Requested approval — ${payload.action_type || "action"} (${payload.risk_level || "?"} risk)`;
    case "approval.approved":
      return "Approval granted by operator";
    case "approval.rejected":
      return "Approval rejected by operator";
    case "approval.result":
      return `Action ${payload.result || "completed"}`;
    case "agent.heartbeat":
      return `Heartbeat — ${payload.status || "ok"}`;
    case "agent.pause":
      return "Agent paused by operator";
    case "agent.resume":
      return "Agent resumed by operator";
    case "agent.quarantine":
    case "agent.auto_quarantined":
      return `Agent quarantined${payload.reason ? ` — ${payload.reason}` : ""}`;
    case "conversation.stalled":
      return `⏸ hit the agent-to-agent turn budget${payload.budget ? ` (${payload.budget})` : ""} — thread paused until you nudge or resume`;
    case "conversation.resumed":
      return "▶ Thread resumed — everyone has a fresh turn budget";
    case "message.delivered":
      return "Message delivered";
    case "message.acked":
      return "Message acknowledged";
    case "message.expired":
      return "Message expired";
    case "message.dead_lettered":
      return "Message dead-lettered";
    case "message.policy_denied":
      return `Blocked by policy${payload.policy_name ? ` — ${payload.policy_name}` : ""}`;
    default:
      return type.replace(/\./g, " · ");
  }
}

export function parsePayload(raw) {
  if (!raw) return {};
  if (typeof raw !== "string") return raw || {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

export function isHeartbeatEvent(type) {
  return type === "agent.heartbeat" || type === "message.delivered" || type === "message.acked";
}

// A glyph that self-describes a channel's kind: # room, 📰 feed, ◈ direct thread.
export function channelGlyph(convId, rooms = []) {
  const id = String(convId || "");
  if (id.startsWith("feed-")) return "📰";
  if (id.startsWith("room_") || rooms.some((r) => r.id === id)) return "#";
  return "◈";
}

// A short, scannable date label for the signal-log dividers: TODAY / YESTERDAY
// for the recent two days, otherwise "29 JUN" (day + uppercase month).
export function dayKey(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toDateString();
}
export function dayDividerLabel(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "TODAY";
  if (d.toDateString() === yesterday.toDateString()) return "YESTERDAY";
  return d.toLocaleDateString([], { day: "2-digit", month: "short" }).toUpperCase();
}

// Verification state for a signal line, from data already on the message:
//   "verified"  — carries an operator cryptographic signature (✓)
//   "attested"  — relayed through the signed store-and-forward relay (·)
//   ""          — still in flight (optimistic), nothing to attest yet
export function verificationOf(item) {
  if (item.pending) return "";
  if (item.side === "operator" && item.signed) return "verified";
  return "attested";
}

export const RAIL_LEFT_KEY = "ekho.rail.left.collapsed.v1";
export const RAIL_RIGHT_KEY = "ekho.rail.right.collapsed.v1";
export const loadRailCollapsed = (key) => {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
};
export const saveRailCollapsed = (key, val) => {
  try { localStorage.setItem(key, val ? "1" : "0"); } catch { /* storage unavailable */ }
};

export function cap(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

/* =====================================================================
   useConsoleState — every piece of console state, derived data, and
   behavior, verbatim from App.jsx. Returns one object; the render layer
   destructures what it needs.
   ===================================================================== */
export function useConsoleState() {
  const [session, setSession] = useState(loadSession());
  const now = useNow();

  // data sections
  const [overview, setOverview] = useState({ agents: [], pendingApprovals: 0, queuedMessages: 0, recentEvents: [] });
  const [agents, setAgents] = useState([]);
  const [agentsTotal, setAgentsTotal] = useState(0);
  const [approvals, setApprovals] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [deadLetters, setDeadLetters] = useState([]);
  const [deadLettersTotal, setDeadLettersTotal] = useState(0);
  const [agentRateLimits, setAgentRateLimits] = useState([]);

  // selection
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [agentDetail, setAgentDetail] = useState(null);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [timelineEvents, setTimelineEvents] = useState([]);
  // Infinite scroll-back: events OLDER than the live window, loaded on demand
  // and kept across polls. Reset per conversation (effect below).
  const [olderEvents, setOlderEvents] = useState([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // ui state
  const [agentStatusFilter, setAgentStatusFilter] = useState("all");
  const [agentSearch, setAgentSearch] = useState("");
  const [rightTab, setRightTab] = useState("health");
  const [showSystem, setShowSystem] = useState(false);
  // Mobile navigation (no effect on desktop — gated by CSS media query):
  // 'list' shows the fleet/conversations rail; 'chat' shows the conversation.
  const [mobileView, setMobileView] = useState("list");
  const [opsOpen, setOpsOpen] = useState(false); // right-rail drawer (mobile)
  const [leftCollapsed, setLeftCollapsed] = useState(() => loadRailCollapsed(RAIL_LEFT_KEY));
  const [rightCollapsed, setRightCollapsed] = useState(() => loadRailCollapsed(RAIL_RIGHT_KEY));
  const toggleLeftRail = () => setLeftCollapsed((v) => { const n = !v; saveRailCollapsed(RAIL_LEFT_KEY, n); return n; });
  const toggleRightRail = () => setRightCollapsed((v) => { const n = !v; saveRailCollapsed(RAIL_RIGHT_KEY, n); return n; });
  // When a chat is opened by tracing from an Ops-drawer tab (Approvals/Agent/…),
  // remember that tab so mobile can offer a one-tap "back to where you were".
  const [traceReturn, setTraceReturn] = useState(null);
  const [composerText, setComposerText] = useState("");
  const [composerRecipient, setComposerRecipient] = useState("broadcast");
  const [rooms, setRooms] = useState([]);
  const [roomModalOpen, setRoomModalOpen] = useState(false);
  const [roomSaving, setRoomSaving] = useState(false);
  const [resumePending, setResumePending] = useState(false); // resume-thread call in flight
  const [fleetHealth, setFleetHealth] = useState([]);
  const [attention, setAttention] = useState({ items: [], counts: { critical: 0, warn: 0 } });
  const [topology, setTopology] = useState({ nodes: [], edges: [], window_minutes: 60 });
  const [activity, setActivity] = useState([]);
  const [activityFilter, setActivityFilter] = useState("");
  const [feeds, setFeeds] = useState([]);
  const [feedBusy, setFeedBusy] = useState("");
  const [optimistic, setOptimistic] = useState([]); // pending operator messages
  const [sending, setSending] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]); // [{id, filename, mime, size_bytes}]
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [replyTarget, setReplyTarget] = useState(null); // { messageId, text, label } | null
  const [mentionMenu, setMentionMenu] = useState(null); // { query, items, index } | null
  const fileInputRef = useRef(null);
  const composerInputRef = useRef(null);
  const [trustPending, setTrustPending] = useState(""); // agentId whose trust toggle is in-flight
  const [peerPending, setPeerPending] = useState(""); // agentId whose peer-delegation control is in-flight

  // login
  const [formState, setFormState] = useState({ fleet_name: "default", email: "", password: "" });
  const [loginStatus, setLoginStatus] = useState("");
  const [loginTone, setLoginTone] = useState("");

  // tokens
  const [tokenStatus, setTokenStatus] = useState("");
  const [tokenTone, setTokenTone] = useState("");

  // policies modal
  const [policyModalOpen, setPolicyModalOpen] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState(null);
  const [policyForm, setPolicyForm] = useState({ name: "", scope_kind: "fleet", scope_id: "", rule: { action: "deny", conditions: {} }, enabled: true });
  const [policyStatus, setPolicyStatus] = useState("");

  // dead letters
  const [expandedDeadLetter, setExpandedDeadLetter] = useState(null);

  // generic modal (alert / confirm / prompt)
  const [modal, setModal] = useState(null);

  // settings (per-agent colours + typing animation), persisted to localStorage
  const [settings, setSettings] = useState(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const updateSettings = (next) => {
    setSettings(next);
    saveSettings(next);
  };

  // first-load tracking → skeleton only on first load, never on background refresh
  const initialized = useRef({ overview: false, agents: false, approvals: false, policies: false, deadLetters: false });

  // message_ids already fully revealed by the typewriter — so polls/re-renders
  // never restart or re-animate a message that's already been shown.
  const animatedIds = useRef(new Set());
  // message_ids mid-animation right now — keeps them typing across background
  // polls until the Typewriter signals completion (no mid-flight snap to full).
  const typingNow = useRef(new Set());
  const [, forceTick] = useState(0);

  // Relay link health: lastOkRef is stamped on every successful poll; connStale
  // flips true only after auto-refresh has failed for a few intervals (a real
  // outage), so the header pill tells the truth instead of always reading green.
  const [connStale, setConnStale] = useState(false);
  const lastOkRef = useRef(Date.now());
  function markConnectionOk() {
    lastOkRef.current = Date.now();
    setConnStale(false);
  }
  // Errors raised by the background auto-refresh: a 401 still ends the session,
  // but a transient relay/network blip must mark the link stale — never spam a
  // modal on every 5s tick.
  function noteConnectionTrouble(error) {
    if (error instanceof ApiError && error.status === 401) {
      clearStoredSession();
      setLoginTone("error");
      setLoginStatus("Session expired. Log in again.");
      return;
    }
    if (isConnectionStale(lastOkRef.current, Date.now(), POLL_INTERVAL_MS)) {
      setConnStale(true);
    }
  }
  const markInit = (key) => {
    if (!initialized.current[key]) {
      initialized.current[key] = true;
      forceTick((n) => n + 1);
    }
  };

  // Truthful fleet counts from the health verdict (connection + cognitive),
  // NOT the raw connection status — so the HUD agrees with the Health board.
  // Falls back to the connection status only until the first health poll lands.
  const fleetCounts = useMemo(() => {
    if (fleetHealth.length) {
      let ok = 0, down = 0;
      for (const a of fleetHealth) {
        const lvl = a.health?.level;
        if (lvl === "ok") ok++;
        else if (lvl === "down") down++;
      }
      return { healthy: ok, total: fleetHealth.length, down };
    }
    const agents = overview.agents || [];
    return { healthy: agents.filter((a) => a.status === "healthy").length, total: agents.length, down: 0 };
  }, [fleetHealth, overview.agents]);
  const healthyCount = fleetCounts.healthy;

  /* ---------------- data fetchers (in-place updates, no skeleton churn) ---------------- */

  async function refreshOverview() {
    if (!session.token) return;
    const next = await getOverview(session.token);
    setOverview(next);
    markInit("overview");
  }

  async function refreshAgents() {
    if (!session.token) return;
    const result = await getAgents(session.token, {
      search: agentSearch,
      status: agentStatusFilter,
      sortBy: "last_seen_at",
      sortOrder: "desc",
      page: "1",
      limit: "100",
    });
    setAgents(result.agents || []);
    setAgentsTotal(result.total || 0);
    markInit("agents");
  }

  async function refreshRooms() {
    if (!session.token) return;
    try {
      const result = await getRooms(session.token);
      setRooms(result.rooms || []);
    } catch (error) {
      handleApiError(error, { allowSessionReset: true });
    }
  }

  async function refreshFleetHealth() {
    if (!session.token) return;
    try {
      const result = await getFleetHealth(session.token);
      setFleetHealth(result.agents || []);
      markInit("health");
    } catch (error) {
      noteConnectionTrouble(error); // background refresh — mark stale, no modal
    }
  }

  async function refreshAttention() {
    if (!session.token) return;
    try {
      const result = await getAttention(session.token);
      setAttention({ items: result.items || [], counts: result.counts || { critical: 0, warn: 0 } });
      markInit("attention");
    } catch (error) {
      noteConnectionTrouble(error); // background refresh — mark stale, no modal
    }
  }

  async function refreshTopology() {
    if (!session.token) return;
    try {
      const result = await getTopology(session.token);
      setTopology({ nodes: result.nodes || [], edges: result.edges || [], window_minutes: result.window_minutes || 60 });
      markInit("topology");
    } catch (error) {
      noteConnectionTrouble(error); // background refresh — mark stale, no modal
    }
  }

  async function refreshActivity() {
    if (!session.token) return;
    try {
      const result = await getActivity(session.token, { limit: 60, type: activityFilter || undefined });
      setActivity(result.events || []);
      markInit("activity");
    } catch (error) {
      noteConnectionTrouble(error); // background refresh — mark stale, no modal
    }
  }

  async function refreshFeeds() {
    if (!session.token) return;
    try {
      const result = await getFeeds(session.token);
      setFeeds(result.feeds || []);
      markInit("feeds");
    } catch (error) {
      handleApiError(error, { allowSessionReset: true });
    }
  }

  async function handleCreateFeed({ name, url, subscriberAgentIds }) {
    setFeedBusy("create");
    try {
      await createFeedSource(session.token, { name, url, subscriberAgentIds });
      await refreshFeeds();
    } catch (error) {
      handleApiError(error, { allowSessionReset: true });
      throw error;
    } finally {
      setFeedBusy("");
    }
  }

  async function handlePollFeed(feedId) {
    setFeedBusy(feedId);
    try {
      await pollFeedSource(session.token, feedId);
      await refreshFeeds();
    } catch (error) {
      handleApiError(error, { allowSessionReset: true });
    } finally {
      setFeedBusy("");
    }
  }

  async function handleDeleteFeed(feedId) {
    try {
      await deleteFeedSource(session.token, feedId);
      await refreshFeeds();
    } catch (error) {
      handleApiError(error, { allowSessionReset: true });
    }
  }

  async function handleSetFeedSubscribers(feedId, agentIds) {
    setFeedBusy(`subs-${feedId}`);
    try {
      await setFeedSubscribers(session.token, feedId, agentIds);
      await refreshFeeds();
    } catch (error) {
      handleApiError(error, { allowSessionReset: true });
      throw error;
    } finally {
      setFeedBusy("");
    }
  }

  async function handleCreateRoom(name, memberIds) {
    setRoomSaving(true);
    try {
      const room = await createRoom(session.token, { name, memberAgentIds: memberIds });
      await refreshRooms();
      setComposerRecipient(`room:${room.id}`);
      setRoomModalOpen(false);
    } catch (error) {
      handleApiError(error, { allowSessionReset: true });
    } finally {
      setRoomSaving(false);
    }
  }

  async function handleDeleteRoom(roomId) {
    try {
      await deleteRoom(session.token, roomId);
      if (composerRecipient === `room:${roomId}`) setComposerRecipient("broadcast");
      await refreshRooms();
    } catch (error) {
      handleApiError(error, { allowSessionReset: true });
    }
  }

  async function handleSetProjectMode(roomId, enabled, budget) {
    try {
      await setRoomProjectMode(session.token, roomId, { enabled, budget });
      await refreshRooms();
    } catch (error) {
      handleApiError(error, { allowSessionReset: true });
    }
  }

  async function handleResumeConversation() {
    if (!selectedConversationId || resumePending) return;
    setResumePending(true);
    try {
      await resumeConversation(session.token, selectedConversationId);
      await refreshTimeline();
    } catch (error) {
      handleApiError(error, { allowSessionReset: true });
    } finally {
      setResumePending(false);
    }
  }

  async function refreshApprovals() {
    if (!session.token) return;
    const result = await getApprovals(session.token, { sortBy: "requested_at", sortOrder: "desc", page: "1", limit: "50" });
    setApprovals(result.approvals || []);
    markInit("approvals");
  }

  async function refreshPolicies() {
    if (!session.token) return;
    const result = await getPolicies(session.token);
    setPolicies(result.policies || []);
    markInit("policies");
  }

  async function refreshDeadLetters() {
    if (!session.token) return;
    const result = await getDeadLetters(session.token, { page: "1", limit: "30" });
    setDeadLetters(result.dead_letters || []);
    setDeadLettersTotal(result.total || 0);
    markInit("deadLetters");
  }

  async function refreshTimeline(conversationId = selectedConversationId) {
    if (!session.token || !conversationId) return;
    // Fetch the NEWEST page, then flip to chronological. Ascending page 1 shows
    // a busy conversation's beginning forever — past 100 events the operator
    // stops seeing new replies entirely (they exist, delivered and acked, but
    // never enter the window).
    const result = await getConversationEvents(session.token, conversationId, {
      sortBy: "created_at",
      sortOrder: "desc",
      page: "1",
      limit: String(TIMELINE_LIMIT),
    });
    const events = (result.events || []).slice().reverse();
    // Seam guard: once the operator has scrolled back, new arrivals push the
    // oldest events out of the newest-100 window. Migrate anything that fell
    // below the new window's floor into olderEvents so nothing the operator was
    // already reading silently vanishes.
    if (olderEvents.length && events.length) {
      const floor = events[0];
      const below = (e) => e.created_at < floor.created_at || (e.created_at === floor.created_at && String(e.id) < String(floor.id));
      const slidOut = (timelineEvents || []).filter(below);
      if (slidOut.length) {
        setOlderEvents((prev) => {
          const seen = new Set(prev.map((e) => String(e.id)));
          const add = slidOut.filter((e) => !seen.has(String(e.id)));
          return add.length ? [...prev, ...add] : prev;
        });
      }
    }
    setTimelineEvents(events);
    // A newest window shorter than a full page means there is nothing older to
    // scroll back to. Never flip this back to true here — only loadOlderTimeline
    // decides history is exhausted; a full window leaves it as-is.
    if (events.length < TIMELINE_LIMIT) setHasMoreHistory(false);
    // Drop optimistic items the server has now echoed back, matched by their real
    // message id (bound at send time) — not by text, so identical-text messages
    // reconcile independently. See optimistic.js.
    setOptimistic((items) => reconcileOptimistic(items, result.events, conversationId));
  }

  // Load one page of OLDER events (Telegram-style scroll-back), keyset-paged so
  // it can never skip or duplicate across the boundary. Prepends to olderEvents;
  // the merged timeline (chatItems) shows them above the live window.
  async function loadOlderTimeline() {
    if (!session.token || !selectedConversationId || loadingHistory || !hasMoreHistory) return;
    const merged = [...olderEvents, ...timelineEvents];
    if (!merged.length) return;
    // Oldest currently loaded = the keyset cursor (created_at, id).
    let cursor = merged[0];
    for (const e of merged) {
      if (e.created_at < cursor.created_at || (e.created_at === cursor.created_at && String(e.id) < String(cursor.id))) cursor = e;
    }
    setLoadingHistory(true);
    try {
      const result = await getConversationEvents(session.token, selectedConversationId, {
        sortBy: "created_at",
        sortOrder: "desc",
        before_at: cursor.created_at,
        before_id: String(cursor.id),
        limit: String(TIMELINE_LIMIT),
      });
      const fetched = (result.events || []).slice().reverse(); // chronological
      const known = new Set(merged.map((e) => String(e.id)));
      const fresh = fetched.filter((e) => !known.has(String(e.id)));
      if (fresh.length) setOlderEvents((prev) => [...fresh, ...prev]);
      if ((result.events || []).length < TIMELINE_LIMIT) setHasMoreHistory(false);
    } catch (error) {
      handleApiError(error, { allowSessionReset: true });
    } finally {
      setLoadingHistory(false);
    }
  }

  async function refreshAgentDetail(agentId = selectedAgentId) {
    if (!session.token || !agentId) return;
    try {
      const detail = await getAgentDetail(session.token, agentId);
      setAgentDetail(detail);
    } catch (error) {
      noteConnectionTrouble(error); // background/selection refresh — mark stale, no modal
    }
  }

  async function refreshAgentRateLimits(agentId = selectedAgentId) {
    if (!session.token || !agentId) {
      setAgentRateLimits([]);
      return;
    }
    try {
      const result = await getAgentRateLimits(session.token, agentId);
      setAgentRateLimits(result.violations || []);
    } catch {
      setAgentRateLimits([]);
    }
  }

  /* ---------------- session lifecycle ---------------- */

  function resetState() {
    setOverview({ agents: [], pendingApprovals: 0, queuedMessages: 0, recentEvents: [] });
    setAgents([]);
    setAgentsTotal(0);
    setApprovals([]);
    setPolicies([]);
    setDeadLetters([]);
    setDeadLettersTotal(0);
    setSelectedAgentId("");
    setAgentDetail(null);
    setSelectedConversationId("");
    setTimelineEvents([]);
    setOptimistic([]);
    setAgentRateLimits([]);
    setPendingAttachments([]);
    setComposerError("");
    initialized.current = { overview: false, agents: false, approvals: false, policies: false, deadLetters: false };
  }

  function clearStoredSession() {
    clearSession();
    setSession({ token: "", fleetId: "", email: "" });
    resetState();
  }

  function handleApiError(error, { allowSessionReset = false } = {}) {
    if (allowSessionReset && error instanceof ApiError && error.status === 401) {
      clearStoredSession();
      setLoginTone("error");
      setLoginStatus("Session expired. Log in again.");
      return;
    }
    setModal({ type: "alert", title: "Error", message: error.message });
  }

  async function handleLoginSubmit(event) {
    event.preventDefault();
    setLoginTone("");
    setLoginStatus("Connecting…");
    try {
      const response = await login(formState);
      const nextSession = { token: response.token, fleetId: response.fleet_id, email: formState.email };
      storeSession(nextSession);
      setSession(nextSession);
      setLoginTone("ok");
      setLoginStatus("");
    } catch (error) {
      setLoginTone("error");
      setLoginStatus(`Login failed: ${error.message}`);
    }
  }

  async function handleIssueToken() {
    setTokenTone("");
    setTokenStatus("Issuing…");
    try {
      const response = await issueEnrollmentToken(session.token);
      setTokenTone("ok");
      setTokenStatus(response.token);
    } catch (error) {
      setTokenTone("error");
      setTokenStatus(`Failed: ${error.message}`);
    }
  }

  /* ---------------- actions ---------------- */

  function handleControl(agentId, action) {
    setModal({
      type: "prompt",
      title: `${cap(action)} agent`,
      message: `Reason for ${action} on ${agentId}:`,
      defaultValue: `Operator ${action}`,
      onConfirm: async (reason) => {
        setModal(null);
        try {
          await controlAgent(session.token, agentId, action, { reason });
          await Promise.all([refreshOverview(), refreshAgents(), refreshAgentDetail(agentId)]);
        } catch (error) {
          handleApiError(error, { allowSessionReset: true });
        }
      },
      onCancel: () => setModal(null),
    });
  }

  async function handleSetTrust(agentId, trusted) {
    setTrustPending(agentId);
    try {
      await setAgentTrust(session.token, agentId, trusted);
      await refreshAgents();
    } catch (error) {
      handleApiError(error, { allowSessionReset: true });
    } finally {
      setTrustPending("");
    }
  }

  async function handleSetPeerAutoreply(agentId, autoreply, budget) {
    setPeerPending(agentId);
    try {
      await setPeerAutoreply(session.token, agentId, autoreply, budget);
      await refreshAgents();
    } catch (error) {
      handleApiError(error, { allowSessionReset: true });
    } finally {
      setPeerPending("");
    }
  }

  function handleApproval(approvalId, decision) {
    setModal({
      type: "confirm",
      title: `${cap(decision)} approval`,
      message: `Are you sure you want to ${decision} this request?`,
      confirmLabel: cap(decision),
      confirmVariant: decision === "approve" ? "primary" : "danger",
      onConfirm: async () => {
        setModal(null);
        try {
          await resolveApproval(session.token, approvalId, decision);
          await Promise.all([refreshOverview(), refreshApprovals()]);
        } catch (error) {
          handleApiError(error, { allowSessionReset: true });
        }
      },
      onCancel: () => setModal(null),
    });
  }

  function selectAgent(agentId) {
    setSelectedAgentId(agentId);
    setRightTab("agent");
    setMobileView("chat"); // mobile: open the chat (composer pre-targeted) so you can message this agent
    setOpsOpen(false);
    setTraceReturn(null); // a fresh agent selection isn't a trace — drop any stale breadcrumb
    refreshAgentDetail(agentId);
    refreshAgentRateLimits(agentId);
    if (agentId !== "broadcast") setComposerRecipient(agentId);
  }

  function selectConversation(conversationId) {
    if (!conversationId) return;
    setSelectedConversationId(conversationId);
    setTimelineEvents([]);
    setMobileView("chat"); // mobile: open the conversation full-screen
    setOpsOpen(false);
    refreshTimeline(conversationId).catch((error) => handleApiError(error, { allowSessionReset: true }));
  }

  // Trace a conversation FROM an Ops-drawer tab: remember which tab so mobile can
  // offer a one-tap return (selectConversation closes the drawer + opens the chat).
  function traceFromOps(conversationId) {
    setTraceReturn(rightTab);
    selectConversation(conversationId);
  }

  // Mobile "‹ Fleet": back to the conversation list, dropping any trace breadcrumb.
  function backToList() {
    setMobileView("list");
    setTraceReturn(null);
  }

  // Mobile breadcrumb: reopen the Ops drawer on the tab the trace came from.
  function returnFromTrace() {
    if (!traceReturn) return;
    setRightTab(traceReturn);
    setTraceReturn(null);
    setOpsOpen(true);
  }

  const swipeBack = useEdgeSwipeBack(backToList);

  /* ---------------- attachments ---------------- */

  // Read a File → bare base64 (strip the "data:<mime>;base64," prefix).
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.onload = () => {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.readAsDataURL(file);
    });
  }

  async function ingestFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setComposerError("");

    // Respect the per-message count cap (server is authoritative; this is UX).
    const room = ATTACHMENT_MAX_PER_MESSAGE - pendingAttachments.length;
    if (room <= 0) {
      setComposerError(`Up to ${ATTACHMENT_MAX_PER_MESSAGE} attachments per message.`);
      return;
    }
    const accepted = [];
    const rejected = [];
    for (const file of files.slice(0, room)) {
      const mime = resolveAttachmentMime(file);
      if (!isAllowedAttachmentMime(mime)) {
        rejected.push(`${file.name} — unsupported type`);
      } else if (file.size > ATTACHMENT_MAX_BYTES) {
        rejected.push(`${file.name} — over ${formatBytes(ATTACHMENT_MAX_BYTES)}`);
      } else {
        accepted.push({ file, mime });
      }
    }
    if (files.length > room) rejected.push(`only ${room} more allowed this message`);

    setUploading(true);
    try {
      for (const { file, mime } of accepted) {
        try {
          const dataBase64 = await readFileAsBase64(file);
          const sizeBytes = file.size;
          const meta = await uploadOperatorAttachment(session.token, {
            filename: file.name,
            mime,
            dataBase64,
            sizeBytes,
          });
          setPendingAttachments((items) => [...items, meta]);
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            handleApiError(error, { allowSessionReset: true });
            return;
          }
          rejected.push(`${file.name} — ${error.message || "upload failed"}`);
        }
      }
    } finally {
      setUploading(false);
    }
    if (rejected.length) setComposerError(rejected.join(" · "));
  }

  function handleFilePick(event) {
    const { files } = event.target;
    ingestFiles(files);
    event.target.value = ""; // allow re-selecting the same file
  }

  function handleComposerDrop(event) {
    event.preventDefault();
    setDragActive(false);
    if (event.dataTransfer?.files?.length) ingestFiles(event.dataTransfer.files);
  }

  function removePendingAttachment(id) {
    setPendingAttachments((items) => items.filter((a) => a.id !== id));
    setComposerError("");
  }

  // Roster the @-autocomplete + parser resolve against (operator agent rows use
  // `id`; the mention helpers expect `agent_id`).
  const mentionable = useMemo(
    () => agents.map((a) => ({ agent_id: a.id, display_name: a.display_name || a.id })),
    [agents]
  );
  const mentionNames = useMemo(
    () => new Set(mentionable.map((a) => String(a.display_name).toLowerCase())),
    [mentionable]
  );

  function syncMentionMenu(text, caret) {
    const ctx = mentionContext(text, caret ?? text.length);
    if (!ctx.active) return setMentionMenu(null);
    const items = filterAgents(mentionable, ctx.query);
    setMentionMenu(items.length ? { query: ctx.query, items, index: 0 } : null);
  }
  function onComposerChange(e) {
    setComposerText(e.target.value);
    syncMentionMenu(e.target.value, e.target.selectionStart);
  }
  function chooseMention(agent) {
    const el = composerInputRef.current;
    const caret = el ? el.selectionStart : composerText.length;
    const r = insertMention(composerText, caret, agent.display_name);
    setComposerText(r.text);
    setMentionMenu(null);
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(r.caret, r.caret);
      }
    });
  }
  // Keystrokes while the @-menu is open: navigate/select; otherwise Enter sends.
  function onComposerKeyDown(e) {
    if (mentionMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        return setMentionMenu((m) => ({ ...m, index: (m.index + 1) % m.items.length }));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        return setMentionMenu((m) => ({ ...m, index: (m.index - 1 + m.items.length) % m.items.length }));
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        return chooseMention(mentionMenu.items[mentionMenu.index]);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return setMentionMenu(null);
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleSend() {
    const text = composerText.trim();
    const attachmentIds = pendingAttachments.map((a) => a.id);
    // The relay requires non-empty message text (operatorMessageSchema.text is
    // min(1)); attachments ride alongside the text, they don't replace it. If the
    // operator queued files but typed nothing, prompt for a caption instead of
    // firing a request the server will reject.
    if (!text) {
      if (attachmentIds.length && !sending && !uploading) {
        setComposerError("Add a message to send with your attachment.");
      }
      return;
    }
    if (sending || uploading) return;
    const mentions = parseMentions(text, mentionable);
    const replyTo = replyTarget?.messageId;
    const recipient = composerRecipient || "broadcast";
    const isRoom = recipient.startsWith("room:");
    const roomId = isRoom ? recipient.slice("room:".length) : undefined;
    // A room message threads under the room id; otherwise the selected thread —
    // but never a feed thread (a one-way ingest), which would staple the message
    // into the feed. See compose.js.
    const convId = resolveOutgoingConversationId({ isRoom, roomId, selectedConversationId });
    const sentAttachments = pendingAttachments;
    const optimisticItem = {
      id: `optim-${Date.now()}`,
      conversationId: convId || "__pending__",
      text,
      attachments: sentAttachments,
      createdAt: new Date().toISOString(),
    };
    setOptimistic((items) => [...items, optimisticItem]);
    setComposerText("");
    setPendingAttachments([]);
    setComposerError("");
    setReplyTarget(null);
    setMentionMenu(null);
    setSending(true);
    try {
      // Sign the message with the operator identity when one is unlocked, so the
      // agent can verify it's genuinely you (independent of the relay).
      let signature;
      const unlocked = getUnlocked();
      if (unlocked && session.fleetId) {
        const operatorId = String(session.token).split(".")[0];
        const recipientObj = isRoom
          ? { kind: "room", id: roomId }
          : recipient === "broadcast"
            ? { kind: "broadcast" }
            : { kind: "agent", id: recipient };
        const canonical = buildOperatorCanonical({
          fleetId: session.fleetId,
          operatorId,
          keyId: unlocked.keyId,
          recipient: recipientObj,
          conversationId: convId || "",
          text,
          nonce: randomNonce(),
          sentAt: new Date().toISOString(),
        });
        signature = {
          operator_sig: signCanonical(canonical, unlocked.seed),
          key_id: unlocked.keyId,
          sig_canonical: canonical,
        };
      }
      const res = await sendOperatorMessage(session.token, {
        recipientAgentId: isRoom ? undefined : recipient,
        roomId,
        text,
        conversationId: convId,
        attachmentIds: attachmentIds.length ? attachmentIds : undefined,
        mentions: mentions.length ? mentions : undefined,
        replyTo,
        signature,
      });
      const newConvId = res.conversation_id;
      // Bind the optimistic item to the resolved conversation id AND the real
      // message id, so reconcileOptimistic can drop it by id when the server
      // echoes it back (instead of a fragile text match).
      setOptimistic((items) => items.map((o) => (o.id === optimisticItem.id ? { ...o, conversationId: newConvId, messageId: res.message_id } : o)));
      if (newConvId && newConvId !== selectedConversationId) {
        setSelectedConversationId(newConvId);
      }
      await refreshTimeline(newConvId);
      await refreshOverview();
    } catch (error) {
      setOptimistic((items) => items.filter((o) => o.id !== optimisticItem.id));
      setComposerText(text);
      setPendingAttachments(sentAttachments); // restore so the operator can retry
      handleApiError(error, { allowSessionReset: true });
    } finally {
      setSending(false);
    }
  }

  /* ---------------- policy CRUD ---------------- */

  function openPolicyCreate() {
    setEditingPolicy(null);
    setPolicyForm({ name: "", scope_kind: "fleet", scope_id: "", rule: { action: "deny", conditions: {} }, enabled: true });
    setPolicyStatus("");
    setPolicyModalOpen(true);
  }

  function openPolicyEdit(policy) {
    setEditingPolicy(policy);
    const rule = typeof policy.rule_json === "string" ? JSON.parse(policy.rule_json) : policy.rule_json || { action: "deny", conditions: {} };
    setPolicyForm({ name: policy.name, scope_kind: policy.scope_kind, scope_id: policy.scope_id || "", rule, enabled: Boolean(policy.enabled) });
    setPolicyStatus("");
    setPolicyModalOpen(true);
  }

  async function handlePolicySave() {
    try {
      const body = {
        name: policyForm.name,
        scope_kind: policyForm.scope_kind,
        scope_id: policyForm.scope_id || undefined,
        rule: policyForm.rule,
        enabled: policyForm.enabled,
      };
      if (editingPolicy) await updatePolicy(session.token, editingPolicy.id, body);
      else await createPolicy(session.token, body);
      setPolicyModalOpen(false);
      await refreshPolicies();
    } catch (error) {
      setPolicyStatus(error.message);
    }
  }

  function handlePolicyDelete(policyId) {
    setModal({
      type: "confirm",
      title: "Delete policy",
      message: "Are you sure you want to delete this policy?",
      confirmLabel: "Delete",
      confirmVariant: "danger",
      onConfirm: async () => {
        setModal(null);
        try {
          await deletePolicy(session.token, policyId);
          await refreshPolicies();
        } catch (error) {
          handleApiError(error, { allowSessionReset: true });
        }
      },
      onCancel: () => setModal(null),
    });
  }

  /* ---------------- dead letters ---------------- */

  // Toggle a dead letter's detail view: collapse if it's already open, otherwise
  // fetch the full payload from the relay. (Extracted verbatim from the previous
  // inline onExpand handler.)
  async function handleExpandDeadLetter(dl) {
    if (expandedDeadLetter?.id === dl.id) return setExpandedDeadLetter(null);
    try {
      setExpandedDeadLetter(await getDeadLetterDetail(session.token, dl.id));
    } catch (error) {
      handleApiError(error, { allowSessionReset: true });
    }
  }

  /* ---------------- effects ---------------- */

  useEffect(() => {
    if (!session.token) return;
    Promise.all([refreshOverview(), refreshAgents(), refreshApprovals(), refreshPolicies(), refreshDeadLetters(), refreshRooms(), refreshFleetHealth(), refreshAttention(), refreshTopology(), refreshActivity(), refreshFeeds()]).catch((error) =>
      handleApiError(error, { allowSessionReset: true })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.token]);

  useEffect(() => {
    if (!session.token) return;
    refreshAgents().catch((error) => handleApiError(error, { allowSessionReset: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSearch, agentStatusFilter]);

  useEffect(() => {
    if (!session.token) return;
    refreshActivity().catch((error) => handleApiError(error, { allowSessionReset: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityFilter]);

  // Switching conversations discards any scrolled-back history and re-arms the
  // "more to load" flag — path-independent (poll, trace, openChat, send-switch).
  useEffect(() => {
    setOlderEvents([]);
    setHasMoreHistory(true);
    setLoadingHistory(false);
  }, [selectedConversationId]);

  useAutoRefresh(
    Boolean(session.token),
    POLL_INTERVAL_MS,
    () => {
      Promise.all([
        refreshOverview(),
        refreshAgents(),
        refreshApprovals(),
        refreshPolicies(),
        refreshDeadLetters(),
        refreshFleetHealth(),
        refreshAttention(),
        refreshTopology(),
        refreshActivity(),
        selectedConversationId ? refreshTimeline(selectedConversationId) : Promise.resolve(),
        selectedAgentId ? refreshAgentDetail(selectedAgentId) : Promise.resolve(),
        selectedAgentId ? refreshAgentRateLimits(selectedAgentId) : Promise.resolve(),
      ]).then(markConnectionOk).catch(noteConnectionTrouble);
    },
    [session.token, selectedConversationId, selectedAgentId, agentSearch, agentStatusFilter]
  );

  /* ---------------- derived: conversation list + chat items ---------------- */

  const conversationList = useMemo(() => {
    const map = new Map();
    // Primary source: latest message per conversation (from the messages table,
    // immune to the heartbeat noise that floods recentEvents on a busy fleet).
    (overview.recentConversations || []).forEach((c) => {
      if (c.conversation_id) {
        map.set(c.conversation_id, {
          id: c.conversation_id, ts: c.last_at || "", preview: c.preview || "", title: c.title || "",
          // Relay-truthful classification (absent on older relays): "dm" means
          // exactly one agent participant; "group" is a multi-agent thread.
          kind: c.kind, participants: c.participants,
        });
      }
    });
    // Fallbacks only fill in conversations the messages query didn't return —
    // they never override a real message preview.
    const considerIfNew = (convId, ts, preview) => {
      if (convId && !map.has(convId)) map.set(convId, { id: convId, ts: ts || "", preview: preview || "" });
    };
    (overview.recentEvents || []).forEach((e) => {
      if (e.conversation_id) considerIfNew(e.conversation_id, e.created_at, humanizeEvent(e.event_type, {}));
    });
    (agentDetail?.recentMessages || []).forEach((m) => considerIfNew(m.conversation_id, m.created_at, `${m.message_type} message`));
    if (selectedConversationId && !map.has(selectedConversationId)) {
      map.set(selectedConversationId, { id: selectedConversationId, ts: "", preview: "" });
    }
    return Array.from(map.values()).sort((a, b) => (b.ts > a.ts ? 1 : -1)).slice(0, 25);
  }, [overview.recentConversations, overview.recentEvents, agentDetail, selectedConversationId]);

  // Human title for a conversation id — room name / agent name / feed label —
  // so the UI never shows a raw conversation id. Prefers the relay-resolved
  // title, falls back to local rooms/agents, then a shortened id.
  const convTitle = (convId) => {
    if (!convId) return "";
    const rc = (overview.recentConversations || []).find((c) => c.conversation_id === convId);
    if (rc?.title) return rc.title;
    const room = rooms.find((r) => r.id === convId);
    if (room) return `# ${room.name}`;
    if (String(convId).startsWith("feed-")) return "📰 News feed";
    return convId.length > 22 ? `${convId.slice(0, 18)}…` : convId;
  };

  // agent_id → display_name, built from the live agents list. Used to label
  // chat bubbles and to enumerate the fleet for broadcast typing indicators.
  const agentNames = useMemo(() => {
    const map = new Map();
    agents.forEach((a) => {
      const id = a.id || a.agent_id;
      if (id) map.set(id, a.display_name || id);
    });
    return map;
  }, [agents]);
  const nameFor = (agentId) => agentNames.get(agentId) || agentId;

  // The full timeline = loaded-older history + the live newest window, deduped
  // by event id (the keyset boundary can re-surface an event) and chronological.
  const timelineMerged = useMemo(() => {
    if (!olderEvents.length) return timelineEvents || [];
    const byId = new Map();
    for (const e of olderEvents) byId.set(String(e.id), e);
    for (const e of timelineEvents || []) byId.set(String(e.id), e);
    return Array.from(byId.values()).sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
  }, [olderEvents, timelineEvents]);

  const chatItems = useMemo(() => {
    const events = timelineMerged;
    // Delivery/ack receipts are collapsed into per-message ticks (WhatsApp-style)
    // instead of their own bubbles. Aggregate them by the message id they target.
    const receipts = new Map(); // messageId → { delivered:Set<actor>, acked:Set<actor> }
    for (const e of events) {
      const t = e.event_type || "";
      if (t !== "message.delivered" && t !== "message.acked") continue;
      const mid = e.resource_kind === "message" ? e.resource_id || "" : "";
      if (!mid) continue;
      let r = receipts.get(mid);
      if (!r) { r = { delivered: new Set(), acked: new Set() }; receipts.set(mid, r); }
      const who = e.actor_id || "?";
      r.delivered.add(who); // an ack implies delivery
      if (t === "message.acked") r.acked.add(who);
    }
    const deliveryStatus = (messageId) => {
      const r = messageId && receipts.get(messageId);
      if (!r) return { status: "sent", deliveredN: 0, ackedN: 0 };
      const deliveredN = r.delivered.size;
      const ackedN = r.acked.size;
      // "read" only once everyone who received it has acked, so a partial ack in a
      // room stays at "delivered" (✓✓ grey) with the counts in the tooltip.
      const status = ackedN > 0 && ackedN >= deliveredN ? "read" : deliveredN > 0 ? "delivered" : "sent";
      return { status, deliveredN, ackedN };
    };
    const fromEvents = events
      .filter((e) => { const t = e.event_type || ""; return t !== "message.delivered" && t !== "message.acked"; })
      .map(describeEvent)
      .map((i) => (i.kind === "message" && i.side === "operator" ? { ...i, ...deliveryStatus(i.messageId) } : i));
    const visible = showSystem ? fromEvents : fromEvents.filter((i) => i.kind === "message" || !isHeartbeatEvent(i.type));
    const pending = optimistic
      .filter((o) => o.conversationId === selectedConversationId)
      .map((o) => ({ id: o.id, kind: "message", side: "operator", senderId: "operator", senderLabel: "Operator", text: o.text, attachments: o.attachments || [], type: "message.queued", createdAt: o.createdAt, pending: true, status: "pending" }));
    return [...visible, ...pending];
  }, [timelineMerged, showSystem, optimistic, selectedConversationId]);

  /* Who is currently "typing"? Derived purely from the polled timeline, so it
     survives refresh and never relies on ephemeral state:
       - For each recent OPERATOR message (created within ~120s), the expected
         repliers are: a direct message → its recipient agent; a broadcast → the
         whole fleet (from the agents list).
       - An expected replier is "typing" if there is NO agent message from that
         agent created AFTER the triggering operator message.
       - The triggering message must be younger than ~120s (older ⇒ assume no
         reply is coming, so clear the indicator).
     Returns [{ agentId, label }] for agents still owed a reply. */
  const typingAgents = useMemo(() => {
    if (!settings.typingAnimation || !selectedConversationId) return [];
    const messages = (timelineEvents || [])
      .filter((e) => (e.event_type || "") === "message.queued")
      .map((e) => describeEvent(e))
      .filter((i) => i.kind === "message");

    const FRESH_MS = 120_000;
    const owed = new Map(); // agentId → triggering operator message time (ms)

    for (const item of messages) {
      if (item.side !== "operator") continue;
      const opTs = new Date(item.createdAt).getTime();
      if (!Number.isFinite(opTs) || now - opTs > FRESH_MS) continue;

      const targets =
        item.recipientKind === "broadcast"
          ? Array.from(agentNames.keys())
          : item.recipientId
          ? [item.recipientId]
          : [];

      for (const agentId of targets) {
        // has this agent already replied after this operator message?
        const replied = messages.some(
          (m) => m.side === "agent" && m.senderId === agentId && new Date(m.createdAt).getTime() > opTs
        );
        if (!replied) {
          const prev = owed.get(agentId);
          if (prev === undefined || opTs > prev) owed.set(agentId, opTs);
        }
      }
    }

    return Array.from(owed.keys()).map((agentId) => ({ agentId, label: nameFor(agentId) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineEvents, selectedConversationId, agentNames, settings.typingAnimation, now]);

  const recipientOptions = useMemo(() => {
    const opts = [{ value: "broadcast", label: "Broadcast — all agents" }];
    rooms.forEach((r) => opts.push({ value: `room:${r.id}`, label: `# ${r.name} (${r.members?.length ?? 0})` }));
    agents.forEach((a) => opts.push({ value: a.id, label: a.display_name || a.id }));
    opts.push({ value: "__manage_rooms__", label: "＋ Manage rooms…" });
    return opts;
  }, [agents, rooms]);

  // The agent whose card the Agent tab shows (list row wins; detail as fallback).
  const selectedAgent = agents.find((a) => a.id === selectedAgentId) || agentDetail?.agent;

  return {
    /* ---- state ---- */
    session,
    overview,
    agents,
    agentsTotal,
    approvals,
    policies,
    deadLetters,
    deadLettersTotal,
    agentRateLimits,
    selectedAgentId,
    agentDetail,
    selectedConversationId,
    timelineEvents,
    olderEvents,
    hasMoreHistory,
    loadingHistory,
    loadOlderTimeline,
    agentStatusFilter,
    agentSearch,
    rightTab,
    showSystem,
    mobileView,
    opsOpen,
    leftCollapsed,
    rightCollapsed,
    traceReturn,
    composerText,
    composerRecipient,
    rooms,
    roomModalOpen,
    roomSaving,
    resumePending,
    fleetHealth,
    attention,
    topology,
    activity,
    activityFilter,
    feeds,
    feedBusy,
    optimistic,
    sending,
    pendingAttachments,
    uploading,
    dragActive,
    composerError,
    replyTarget,
    mentionMenu,
    trustPending,
    peerPending,
    formState,
    loginStatus,
    loginTone,
    tokenStatus,
    tokenTone,
    policyModalOpen,
    editingPolicy,
    policyForm,
    policyStatus,
    expandedDeadLetter,
    modal,
    settings,
    settingsOpen,
    helpOpen,
    connStale,
    now,

    /* ---- setters ---- */
    setSession,
    setOverview,
    setAgents,
    setAgentsTotal,
    setApprovals,
    setPolicies,
    setDeadLetters,
    setDeadLettersTotal,
    setAgentRateLimits,
    setSelectedAgentId,
    setAgentDetail,
    setSelectedConversationId,
    setTimelineEvents,
    setAgentStatusFilter,
    setAgentSearch,
    setRightTab,
    setShowSystem,
    setMobileView,
    setOpsOpen,
    setLeftCollapsed,
    setRightCollapsed,
    setTraceReturn,
    setComposerText,
    setComposerRecipient,
    setRooms,
    setRoomModalOpen,
    setRoomSaving,
    setResumePending,
    setFleetHealth,
    setAttention,
    setTopology,
    setActivity,
    setActivityFilter,
    setFeeds,
    setFeedBusy,
    setOptimistic,
    setSending,
    setPendingAttachments,
    setUploading,
    setDragActive,
    setComposerError,
    setReplyTarget,
    setMentionMenu,
    setTrustPending,
    setPeerPending,
    setFormState,
    setLoginStatus,
    setLoginTone,
    setTokenStatus,
    setTokenTone,
    setPolicyModalOpen,
    setEditingPolicy,
    setPolicyForm,
    setPolicyStatus,
    setExpandedDeadLetter,
    setModal,
    setSettings,
    setSettingsOpen,
    setHelpOpen,
    setConnStale,

    /* ---- refs (render layer attaches these) ---- */
    fileInputRef,
    composerInputRef,
    initialized,
    animatedIds,
    typingNow,

    /* ---- memos / derived ---- */
    fleetCounts,
    healthyCount,
    conversationList,
    convTitle,
    agentNames,
    nameFor,
    chatItems,
    typingAgents,
    recipientOptions,
    mentionable,
    mentionNames,
    selectedAgent,
    swipeBack,

    /* ---- handlers ---- */
    toggleLeftRail,
    toggleRightRail,
    markConnectionOk,
    noteConnectionTrouble,
    updateSettings,
    refreshOverview,
    refreshAgents,
    refreshRooms,
    refreshFleetHealth,
    refreshAttention,
    refreshTopology,
    refreshActivity,
    refreshFeeds,
    refreshApprovals,
    refreshPolicies,
    refreshDeadLetters,
    refreshTimeline,
    refreshAgentDetail,
    refreshAgentRateLimits,
    handleCreateFeed,
    handlePollFeed,
    handleDeleteFeed,
    handleSetFeedSubscribers,
    handleCreateRoom,
    handleDeleteRoom,
    handleSetProjectMode,
    handleResumeConversation,
    resetState,
    clearStoredSession,
    handleApiError,
    handleLoginSubmit,
    handleIssueToken,
    handleControl,
    handleSetTrust,
    handleSetPeerAutoreply,
    handleApproval,
    selectAgent,
    selectConversation,
    traceFromOps,
    backToList,
    returnFromTrace,
    ingestFiles,
    handleFilePick,
    handleComposerDrop,
    removePendingAttachment,
    syncMentionMenu,
    onComposerChange,
    chooseMention,
    onComposerKeyDown,
    handleSend,
    openPolicyCreate,
    openPolicyEdit,
    handlePolicySave,
    handlePolicyDelete,
    handleExpandDeadLetter,

    /* ---- constants ---- */
    POLL_INTERVAL_MS,
    TIMELINE_LIMIT,
    NEW_MESSAGE_MS,
    RAIL_TAB_LABELS,
  };
}
