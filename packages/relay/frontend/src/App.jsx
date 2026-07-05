import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  AttachmentList,
  Avatar,
  Badge,
  ConfirmDialog,
  EmptyState,
  HelpModal,
  LiveDot,
  Modal,
  PaperclipIcon,
  PromptDialog,
  SettingsModal,
  Skeleton,
  StatChip,
  StatusDot,
  StatusMessage,
  TypingDots,
  Typewriter,
  clockTime,
  colorForAgent,
  colorForId,
  formatBytes,
  isAllowedAttachmentMime,
  loadSettings,
  prefersReducedMotion,
  relativeTime,
  resolveAttachmentMime,
  saveSettings,
} from "./components";
import { useAutoRefresh, useEdgeSwipeBack, useNow } from "./hooks";
import { reconcileOptimistic } from "./optimistic.js";
import { resolveOutgoingConversationId } from "./compose.js";
import { isConnectionStale } from "./connection.js";
import SecurityScreen from "./SecurityScreen.jsx";
import { getUnlocked } from "./operatorKeyStore.js";
import { buildOperatorCanonical, signCanonical, randomNonce } from "./operatorKey.js";
import { mentionContext, insertMention, parseMentions, filterAgents } from "./mentions.js";

const POLL_INTERVAL_MS = 5000;
const TIMELINE_LIMIT = 100;

// Short labels for the right-rail Ops tabs, used by the mobile "back to where you
// were" breadcrumb when a chat was opened by tracing from one of them.
const RAIL_TAB_LABELS = {
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
function describeEvent(event) {
  const payload = parsePayload(event.payload_json);
  const type = event.event_type || "";
  const isOperator = event.actor_kind === "operator" || payload.sender_label === "Operator";
  const isMessage = type === "message.queued";
  // Feed items (rendered from messages by getFeedConversation) — a one-way news
  // stream, labelled by the feed name rather than an agent/operator.
  const isFeed = isMessage && (event.actor_kind === "feed" || payload.message_type === "feed");
  const feedName = isFeed ? (payload.feed || "Feed") : undefined;
  const isSystem = !isMessage && (event.actor_kind === "system" || /^(approval|policy|agent)\./.test(type));

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

function humanizeEvent(type, payload) {
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

function parsePayload(raw) {
  if (!raw) return {};
  if (typeof raw !== "string") return raw || {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function isHeartbeatEvent(type) {
  return type === "agent.heartbeat" || type === "message.delivered" || type === "message.acked";
}

// A glyph that self-describes a channel's kind: # room, 📰 feed, ◈ direct thread.
function channelGlyph(convId, rooms = []) {
  const id = String(convId || "");
  if (id.startsWith("feed-")) return "📰";
  if (id.startsWith("room_") || rooms.some((r) => r.id === id)) return "#";
  return "◈";
}

// A short, scannable date label for the signal-log dividers: TODAY / YESTERDAY
// for the recent two days, otherwise "29 JUN" (day + uppercase month).
function dayKey(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toDateString();
}
function dayDividerLabel(value) {
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
function verificationOf(item) {
  if (item.pending) return "";
  if (item.side === "operator" && item.signed) return "verified";
  return "attested";
}

const RAIL_LEFT_KEY = "ekho.rail.left.collapsed.v1";
const RAIL_RIGHT_KEY = "ekho.rail.right.collapsed.v1";
const loadRailCollapsed = (key) => {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
};
const saveRailCollapsed = (key, val) => {
  try { localStorage.setItem(key, val ? "1" : "0"); } catch { /* storage unavailable */ }
};

export default function App() {
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
    const result = await getConversationEvents(session.token, conversationId, {
      sortBy: "created_at",
      sortOrder: "asc",
      page: "1",
      limit: String(TIMELINE_LIMIT),
    });
    setTimelineEvents(result.events || []);
    // Drop optimistic items the server has now echoed back, matched by their real
    // message id (bound at send time) — not by text, so identical-text messages
    // reconcile independently. See optimistic.js.
    setOptimistic((items) => reconcileOptimistic(items, result.events, conversationId));
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
      if (c.conversation_id) map.set(c.conversation_id, { id: c.conversation_id, ts: c.last_at || "", preview: c.preview || "", title: c.title || "" });
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

  const chatItems = useMemo(() => {
    const events = timelineEvents || [];
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
  }, [timelineEvents, showSystem, optimistic, selectedConversationId]);

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

  /* ---------------- login screen ---------------- */

  if (!session.token) {
    return (
      <div className="boot-screen">
        <form className="auth-card" onSubmit={handleLoginSubmit}>
          <div className="eyebrow auth-card__eyebrow">▸ Operator Terminal</div>
          <div className="auth-card__brand">
            <span className="brand-mark">E</span>
            <div>
              <div className="brand-name">Ekho</div>
              <div className="brand-sub">by Drakon Systems</div>
            </div>
          </div>
          <p className="auth-card__lede">Authenticate to monitor, steer, and message your private agent fleet.</p>
          <label className="field">
            <span>Fleet</span>
            <input value={formState.fleet_name} onChange={(e) => setFormState((v) => ({ ...v, fleet_name: e.target.value }))} autoComplete="off" />
          </label>
          <label className="field">
            <span>Email</span>
            <input type="email" value={formState.email} onChange={(e) => setFormState((v) => ({ ...v, email: e.target.value }))} autoComplete="username" />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" value={formState.password} onChange={(e) => setFormState((v) => ({ ...v, password: e.target.value }))} autoComplete="current-password" />
          </label>
          <button className="button button--block" type="submit">Open console</button>
          <StatusMessage tone={loginTone}>{loginStatus}</StatusMessage>
        </form>
      </div>
    );
  }

  /* ---------------- main app shell ---------------- */

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) || agentDetail?.agent;

  return (
    <div className={`app app--${mobileView}${opsOpen ? " app--ops" : ""}`}>
      <header className="appbar grid-tex">
        <div className="appbar__brand">
          <span className="brand-mark">E</span>
          <div className="appbar__titles">
            <span className="brand-name">
              Ekho <span className="brand-by">by Drakon Systems</span>
            </span>
            <span className="appbar__sub">Operator Terminal · <span className="mono">{session.fleetId}</span></span>
          </div>
        </div>
        {/* Live fleet status line — colour-coded mono telemetry chips. */}
        <div className="appbar__hud" role="status" aria-label="Fleet status">
          <span className={`hud-chip ${fleetCounts.down ? "hud-chip--danger" : "hud-chip--ok"}`} title="Agents healthy (connection + model turns)">
            <span className="hud-chip__v mono">{healthyCount}/{fleetCounts.total}</span>
            <span className="hud-chip__l">healthy</span>
          </span>
          <span className={`hud-chip${overview.pendingApprovals ? " hud-chip--warn" : ""}`} title="Approvals awaiting decision">
            <span className="hud-chip__v mono">{overview.pendingApprovals || 0}</span>
            <span className="hud-chip__l">approvals</span>
          </span>
          <span className={`hud-chip${overview.deadLetterCount ? " hud-chip--danger" : ""}`} title="Undeliverable messages (dead-lettered)">
            <span className="hud-chip__v mono">{overview.deadLetterCount || 0}</span>
            <span className="hud-chip__l">dead-letter</span>
          </span>
        </div>
        <div className="appbar__right">
          <span
            className={`sync-pill${connStale ? " sync-pill--stale" : ""}`}
            title={connStale ? "Relay link degraded — retrying every 5s" : "Live — auto-syncing every 5s"}
          >
            <LiveDot active={!connStale} />
            {connStale ? "reconnecting…" : "live"}
          </span>
          <button className="icon-button appbar__icon" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
            <GearIcon />
          </button>
          <button className="icon-button appbar__icon" onClick={() => setHelpOpen(true)} aria-label="Help" title="Help & setup">
            <HelpIcon />
          </button>
          <button className="button button--sm" title="Open the Command Deck (full-screen HUD) in a new window" onClick={() => window.open("#deck", "_blank", "noopener")}>
            ◎ Deck
          </button>
          <button className="button button--ghost button--sm" onClick={() => Promise.all([refreshOverview(), refreshAgents(), refreshApprovals(), selectedConversationId ? refreshTimeline() : Promise.resolve()]).catch((e) => handleApiError(e, { allowSessionReset: true }))}>
            Refresh
          </button>
          <button className="button button--ghost button--sm" onClick={clearStoredSession}>Log out</button>
        </div>
      </header>

      <div className={`layout${leftCollapsed ? " layout--left-collapsed" : ""}${rightCollapsed ? " layout--right-collapsed" : ""}`}>
        {/* Re-open affordances — thin strips shown only when a rail is collapsed. */}
        <button className="rail-reopen rail-reopen--left" onClick={toggleLeftRail} aria-label="Expand fleet sidebar" title="Expand fleet">›</button>
        <button className="rail-reopen rail-reopen--right" onClick={toggleRightRail} aria-label="Expand operations rail" title="Expand operations">‹</button>
        {/* LEFT RAIL */}
        <aside className="rail rail--left">
          <div className="kpi-strip">
            <StatChip label="Agents" value={overview.agents?.length ?? 0} />
            <StatChip label="Healthy" value={healthyCount} tone="ok" />
            <StatChip label="Approvals" value={overview.pendingApprovals || 0} tone={overview.pendingApprovals ? "warn" : ""} />
            <StatChip label="Dead" value={overview.deadLetterCount || 0} tone={overview.deadLetterCount ? "danger" : ""} />
          </div>

          <div className="rail__section">
            <div className="rail__head">
              <span className="eyebrow">▸ Fleet</span>
              <span className="rail__count mono">{agentsTotal}</span>
            </div>
            <div className="rail__filters">
              <input className="rail__search" placeholder="Search agents" value={agentSearch} onChange={(e) => setAgentSearch(e.target.value)} />
              <select className="rail__statusfilter" value={agentStatusFilter} onChange={(e) => setAgentStatusFilter(e.target.value)}>
                <option value="all">All</option>
                <option value="healthy">Healthy</option>
                <option value="degraded">Degraded</option>
                <option value="paused">Paused</option>
                <option value="quarantined">Quarantined</option>
              </select>
            </div>
            <div className="rail__list">
              {!initialized.current.agents ? (
                <Skeleton count={5} height="52px" />
              ) : agents.length ? (
                agents.map((agent) => (
                  <button
                    key={agent.id}
                    className={`agent-row${agent.id === selectedAgentId ? " agent-row--active" : ""}`}
                    onClick={() => selectAgent(agent.id)}
                  >
                    <Avatar id={agent.id} label={agent.display_name || agent.id} size={34} />
                    <span className="agent-row__main">
                      <span className="agent-row__name">{agent.display_name || agent.id}</span>
                      <span className="agent-row__meta">
                        <span className="mono">{agent.runtime || "custom"}</span> · <span className="mono">{relativeTime(agent.last_seen_at)}</span>
                      </span>
                    </span>
                    <StatusDot status={agent.status} title={agent.status} />
                  </button>
                ))
              ) : (
                <EmptyState>No agents match.</EmptyState>
              )}
            </div>
          </div>

          <div className="rail__section rail__section--grow">
            <div className="rail__head">
              <span className="eyebrow">▸ Channels</span>
              <span className="rail__count mono">{conversationList.length}</span>
            </div>
            <div className="rail__list">
              {conversationList.length ? (
                conversationList.map((c) => {
                  const glyph = channelGlyph(c.id, rooms);
                  return (
                  <button
                    key={c.id}
                    className={`conv-row${c.id === selectedConversationId ? " conv-row--active" : ""}`}
                    onClick={() => selectConversation(c.id)}
                  >
                    <span className="conv-row__glyph" aria-hidden="true">{glyph}</span>
                    <span className="conv-row__dot" style={{ background: colorForId(c.id) }} />
                    <span className="conv-row__main">
                      <span className="conv-row__id">{c.title || convTitle(c.id)}</span>
                      <span className="conv-row__preview">{c.preview || "No signals yet"}</span>
                    </span>
                    {c.ts ? <span className="conv-row__time mono">{relativeTime(c.ts)}</span> : null}
                  </button>
                  );
                })
              ) : (
                <EmptyState>No channels yet — message the fleet to begin.</EmptyState>
              )}
            </div>
          </div>
        </aside>
        {/* Collapse handle — sits on the rail/center divider, revealed on rail hover. */}
        <button className="rail-collapse rail-collapse--left" onClick={toggleLeftRail} aria-label="Collapse fleet sidebar" title="Collapse fleet sidebar">‹</button>

        {/* CENTER — CHAT */}
        <main className="chat" {...swipeBack}>
          <div className="chat__header">
            <button className="chat__back" onClick={backToList} aria-label="Back to fleet">
              ‹ Fleet
            </button>
            {traceReturn && (
              <button
                className="chat__trace-return"
                onClick={returnFromTrace}
                aria-label={`Back to ${RAIL_TAB_LABELS[traceReturn] || traceReturn}`}
                title={`Back to ${RAIL_TAB_LABELS[traceReturn] || traceReturn}`}
              >
                ↩ {RAIL_TAB_LABELS[traceReturn] || traceReturn}
              </button>
            )}
            <div className="chat__heading">
              <span className="eyebrow chat__eyebrow">▸ Signal Log</span>
              {selectedConversationId ? (
                <>
                  <span className="conv-row__dot" style={{ background: colorForId(selectedConversationId) }} />
                  <span className="chat__convid">{convTitle(selectedConversationId)}</span>
                </>
              ) : (
                <span className="chat__placeholder-title">No channel selected</span>
              )}
            </div>
            <label className="toggle toggle--inline">
              <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
              <span>System events</span>
            </label>
            <button className="chat__ops" onClick={() => setOpsOpen(true)} aria-label="Open operations panel">
              Ops
            </button>
          </div>

          <ChatScroller
            items={chatItems}
            hasConversation={Boolean(selectedConversationId)}
            now={now}
            settings={settings}
            typingAgents={typingAgents}
            nameFor={nameFor}
            animatedIds={animatedIds}
            typingNow={typingNow}
            token={session.token}
            onReply={setReplyTarget}
            mentionNames={mentionNames}
          />

          <div
            className={`composer${dragActive ? " composer--drag" : ""}`}
            onDragOver={(e) => {
              if (e.dataTransfer?.types?.includes("Files")) {
                e.preventDefault();
                if (!dragActive) setDragActive(true);
              }
            }}
            onDragLeave={(e) => {
              // only clear when leaving the composer itself, not its children
              if (e.currentTarget === e.target) setDragActive(false);
            }}
            onDrop={handleComposerDrop}
          >
            {dragActive ? <div className="composer__dropveil"><PaperclipIcon /> Drop files to attach</div> : null}

            {(pendingAttachments.length || uploading) ? (
              <div className="composer__attachments">
                {pendingAttachments.map((a) => (
                  <span className="att-pending" key={a.id} title={a.filename}>
                    <span className="att-pending__name">{a.filename}</span>
                    <span className="att-pending__size">{formatBytes(a.size_bytes)}</span>
                    <button
                      type="button"
                      className="att-pending__remove"
                      onClick={() => removePendingAttachment(a.id)}
                      aria-label={`Remove ${a.filename}`}
                    >
                      &times;
                    </button>
                  </span>
                ))}
                {uploading ? (
                  <span className="att-pending att-pending--uploading">
                    <span className="att-spinner" aria-hidden="true" />
                    <span className="att-pending__name">Uploading…</span>
                  </span>
                ) : null}
              </div>
            ) : null}

            {composerError ? <div className="composer__error">{composerError}</div> : null}

            {replyTarget ? (
              <div className="composer__reply">
                <span className="composer__reply-bar" aria-hidden="true" />
                <div className="composer__reply-body">
                  <span className="composer__reply-label">Replying to {replyTarget.label}</span>
                  <span className="composer__reply-text">{replyTarget.text}</span>
                </div>
                <button type="button" className="composer__reply-x" onClick={() => setReplyTarget(null)} aria-label="Cancel reply">✕</button>
              </div>
            ) : null}

            {mentionMenu ? (
              <div className="composer__mentions" role="listbox">
                {mentionMenu.items.map((a, i) => (
                  <button
                    key={a.agent_id}
                    type="button"
                    role="option"
                    aria-selected={i === mentionMenu.index}
                    className={`composer__mention${i === mentionMenu.index ? " composer__mention--active" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); chooseMention(a); }}
                  >
                    <span className="composer__mention-at">@</span>{a.display_name}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="composer__row">
              <select className="composer__recipient" value={composerRecipient} onChange={(e) => { const v = e.target.value; if (v === "__manage_rooms__") { setRoomModalOpen(true); return; } setComposerRecipient(v); if (v.startsWith("room:")) setSelectedConversationId(v.slice("room:".length)); }}>
                {recipientOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ATTACHMENT_ACCEPT}
                className="composer__file"
                onChange={handleFilePick}
                tabIndex={-1}
              />
              <button
                type="button"
                className="composer__attach"
                onClick={() => fileInputRef.current?.click()}
                disabled={pendingAttachments.length >= ATTACHMENT_MAX_PER_MESSAGE || uploading}
                title={pendingAttachments.length >= ATTACHMENT_MAX_PER_MESSAGE ? `Max ${ATTACHMENT_MAX_PER_MESSAGE} attachments` : "Attach files"}
                aria-label="Attach files"
              >
                <PaperclipIcon />
              </button>
              <textarea
                ref={composerInputRef}
                className="composer__input"
                placeholder="Message the fleet…  (@ to mention)"
                title="Enter to send · Shift+Enter for newline · @ to mention an agent"
                value={composerText}
                rows={1}
                onChange={onComposerChange}
                onClick={(e) => syncMentionMenu(e.target.value, e.target.selectionStart)}
                onBlur={() => requestAnimationFrame(() => setMentionMenu(null))}
                onKeyDown={onComposerKeyDown}
              />
              <button
                className="button composer__send"
                onClick={handleSend}
                disabled={!composerText.trim() || sending || uploading}
                title={!composerText.trim() && pendingAttachments.length ? "Add a message to send with your attachment" : undefined}
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </main>

        {/* RIGHT RAIL */}
        <div className="rail-backdrop" onClick={() => setOpsOpen(false)} aria-hidden="true" />
        <aside className="rail rail--right">
          <div className="rail__mobilebar">
            <span className="eyebrow">▸ Operations</span>
            <button className="icon-button" onClick={() => setOpsOpen(false)} aria-label="Close operations panel">✕</button>
          </div>
          <div className="tabs tabs--grouped">
            {[
              ["Monitor", [
                ["attention", `Needs You${attention.items.length ? ` (${attention.items.length})` : ""}`],
                ["health", "Health"],
                ["topology", "Map"],
                ["activity", "Activity"],
              ]],
              ["Control", [
                ["approvals", `Approvals${overview.pendingApprovals ? ` (${overview.pendingApprovals})` : ""}`],
                ["deadletters", "Dead"],
              ]],
              ["Configure", [
                ["feeds", "Feeds"],
                ["agent", "Agent"],
                ["access", "Access"],
                ["policies", "Policies"],
              ]],
              ["Security", [
                ["security", "🛡 Sec"],
              ]],
            ].map(([group, items]) => (
              <div className="tab-group" key={group}>
                <span className="tab-group__label">{group}</span>
                {items.map(([key, label]) => (
                  <button key={key} className={`tab${rightTab === key ? " tab--active" : ""}`} onClick={() => setRightTab(key)}>
                    {label}
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="rail__scroll">
            {rightTab === "approvals" && (
              <ApprovalsTab
                approvals={approvals}
                initialized={initialized.current.approvals}
                onApprove={(id) => handleApproval(id, "approve")}
                onReject={(id) => handleApproval(id, "reject")}
                onTrace={traceFromOps}
              />
            )}

            {rightTab === "attention" && (
              <AttentionTab
                data={attention}
                initialized={initialized.current.attention}
                onSelectAgent={selectAgent}
                onOpenConversation={traceFromOps}
              />
            )}

            {rightTab === "health" && (
              <HealthTab agents={fleetHealth} initialized={initialized.current.health} />
            )}

            {rightTab === "topology" && (
              <TopologyTab data={topology} initialized={initialized.current.topology} onSelect={selectAgent} settings={settings} />
            )}

            {rightTab === "activity" && (
              <ActivityTab
                events={activity}
                agents={agents}
                initialized={initialized.current.activity}
                filter={activityFilter}
                onFilter={setActivityFilter}
                onOpenConversation={traceFromOps}
              />
            )}

            {rightTab === "security" && <SecurityScreen session={session} agents={agents} />}

            {rightTab === "feeds" && (
              <FeedsTab
                feeds={feeds}
                agents={agents}
                initialized={initialized.current.feeds}
                busy={feedBusy}
                onCreate={handleCreateFeed}
                onPoll={handlePollFeed}
                onDelete={handleDeleteFeed}
                onSetSubscribers={handleSetFeedSubscribers}
              />
            )}

            {rightTab === "agent" && (
              <AgentTab
                agent={selectedAgent}
                detail={agentDetail}
                rateLimits={agentRateLimits}
                onControl={handleControl}
                onTrace={traceFromOps}
              />
            )}

            {rightTab === "access" && (
              <AccessTab
                agents={agents}
                initialized={initialized.current.agents}
                trustPending={trustPending}
                onSetTrust={handleSetTrust}
                peerPending={peerPending}
                onSetPeerAutoreply={handleSetPeerAutoreply}
              />
            )}

            {rightTab === "deadletters" && (
              <DeadLettersTab
                deadLetters={deadLetters}
                total={deadLettersTotal}
                initialized={initialized.current.deadLetters}
                expanded={expandedDeadLetter}
                onExpand={async (dl) => {
                  if (expandedDeadLetter?.id === dl.id) return setExpandedDeadLetter(null);
                  try {
                    setExpandedDeadLetter(await getDeadLetterDetail(session.token, dl.id));
                  } catch (error) {
                    handleApiError(error, { allowSessionReset: true });
                  }
                }}
                onTrace={traceFromOps}
              />
            )}

            {rightTab === "policies" && (
              <PoliciesTab
                policies={policies}
                initialized={initialized.current.policies}
                onCreate={openPolicyCreate}
                onEdit={openPolicyEdit}
                onDelete={handlePolicyDelete}
              />
            )}
          </div>

          <div className="rail__foot">
            <button className="button button--ghost button--sm button--block" onClick={handleIssueToken}>Mint enrollment token</button>
            {tokenStatus ? (
              <div className={`token-out${tokenTone === "error" ? " token-out--error" : ""}`}>{tokenStatus}</div>
            ) : null}
            <button className="help-hint" onClick={() => setHelpOpen(true)}>Need help? Click the ? icon</button>
          </div>
        </aside>
        {/* Collapse handle — sits on the operations/center divider, revealed on rail hover. */}
        <button className="rail-collapse rail-collapse--right" onClick={toggleRightRail} aria-label="Collapse operations rail" title="Collapse operations rail">›</button>
      </div>

      {/* modals */}
      {modal?.type === "alert" && (
        <Modal title={modal.title} onClose={() => setModal(null)} actions={[{ label: "OK", onClick: () => setModal(null) }]}>
          <p style={{ margin: 0, lineHeight: 1.6 }}>{modal.message}</p>
        </Modal>
      )}
      {modal?.type === "confirm" && (
        <ConfirmDialog title={modal.title} message={modal.message} onConfirm={modal.onConfirm} onCancel={modal.onCancel} confirmLabel={modal.confirmLabel} confirmVariant={modal.confirmVariant} />
      )}
      {modal?.type === "prompt" && (
        <PromptDialog title={modal.title} message={modal.message} defaultValue={modal.defaultValue} onConfirm={modal.onConfirm} onCancel={modal.onCancel} />
      )}

      {policyModalOpen && (
        <PolicyModal
          editing={Boolean(editingPolicy)}
          form={policyForm}
          setForm={setPolicyForm}
          status={policyStatus}
          onClose={() => setPolicyModalOpen(false)}
          onSave={handlePolicySave}
        />
      )}

      {roomModalOpen && (
        <RoomModal
          agents={agents}
          rooms={rooms}
          saving={roomSaving}
          onCreate={handleCreateRoom}
          onDelete={handleDeleteRoom}
          onClose={() => setRoomModalOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsModal agents={agents} settings={settings} onChange={updateSettings} onClose={() => setSettingsOpen(false)} />
      )}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

/* ---------------- header icons (inline SVG, no deps) ---------------- */

function GearIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

/* ============================ Chat scroller ============================ */

const NEW_MESSAGE_MS = 45_000; // window in which an incoming agent message animates

// WhatsApp-style delivery ticks on the operator's own messages, so per-recipient
// "delivered/acknowledged" receipts don't each take a whole bubble.
// Render message text with @handles that resolve to a real agent highlighted.
// `names` is a Set of lowercased display names; an @token not in it (e.g. an
// email's @host) stays plain text.
function MentionText({ text, names }) {
  const src = String(text ?? "");
  if (!names || names.size === 0) return src;
  const parts = src.split(/(@[\w-]+)/g);
  return (
    <>
      {parts.map((seg, i) =>
        /^@[\w-]+$/.test(seg) && names.has(seg.slice(1).toLowerCase())
          ? <span className="mention" key={i}>{seg}</span>
          : seg
      )}
    </>
  );
}

function DeliveryTicks({ status, deliveredN = 0, ackedN = 0 }) {
  const title =
    status === "pending" ? "Sending…"
    : status === "read" ? `Acknowledged${ackedN ? ` by ${ackedN}` : ""}`
    : status === "delivered" ? `Delivered${deliveredN ? ` to ${deliveredN}` : ""}${ackedN ? ` · read by ${ackedN}` : ""}`
    : "Sent";
  const single = status === "pending" || status === "sent";
  return (
    <span className={`ticks ticks--${status}`} title={title} aria-label={title}>
      {single ? "✓" : "✓✓"}
    </span>
  );
}

function ChatScroller({ items, hasConversation, now, settings, typingAgents, nameFor, animatedIds, typingNow, token, onReply, mentionNames }) {
  const ref = useRef(null);
  const nearBottomRef = useRef(true);

  // track whether the user is near the bottom before the DOM updates
  const handleScroll = () => {
    const el = ref.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const stickToBottom = () => {
    const el = ref.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  };

  useLayoutEffect(() => {
    stickToBottom();
  }, [items.length, hasConversation, typingAgents.length]);

  if (!hasConversation) {
    return (
      <div className="chat__body chat__body--empty" ref={ref}>
        <EmptyState icon="▢" title="Select a channel to view its signal log">
          Pick a channel on the left, or message an agent below to open a new one. Your transmissions reach the agent’s inbox and stream back here live.
        </EmptyState>
      </div>
    );
  }

  if (!items.length && !typingAgents.length) {
    return (
      <div className="chat__body chat__body--empty" ref={ref}>
        <EmptyState icon="▢" title="No signals yet">Message the fleet to begin. Toggle system events to surface heartbeats and delivery receipts.</EmptyState>
      </div>
    );
  }

  const animate = settings.typingAnimation && !prefersReducedMotion();

  return (
    <div className="chat__body" ref={ref} onScroll={handleScroll}>
      {items.map((item, idx) => {
        const prev = items[idx - 1];
        const grouped = prev && prev.kind === item.kind && prev.side === item.side && prev.senderId === item.senderId;
        // A dated rule breaks the log into TODAY / YESTERDAY / "29 JUN" sections
        // so it never reads as an undifferentiated wall.
        const showDay = !prev || dayKey(prev.createdAt) !== dayKey(item.createdAt);
        const dayLabel = showDay ? dayDividerLabel(item.createdAt) : "";
        // Stable identity: the event id (server rows) or the optimistic id
        // (pending sends). Both are unique; idx is only a last-ditch fallback.
        const key = item.id || `${item.type}-${item.createdAt}-${idx}`;
        if (item.kind === "system") {
          return (
            <React.Fragment key={key}>
              {dayLabel ? <div className="day-divider"><span>{dayLabel}</span></div> : null}
              <div className="sys-chip">
                <span>{item.text}</span>
                <span className="sys-chip__time">{clockTime(item.createdAt)}</span>
              </div>
            </React.Fragment>
          );
        }
        const isOp = item.side === "operator";
        const isFeed = Boolean(item.feed);
        const label = isOp ? "Operator" : isFeed ? item.feedName : nameFor(item.senderId);
        const accent = isOp || isFeed ? null : colorForAgent(item.senderId, settings);
        // Agent→agent chatter: a message FROM an agent addressed to another agent
        // (recipient is an agent and not the synthetic operator). Highlighted
        // distinctly so peer coordination stands out from agent↔operator talk.
        const isPeer = item.side === "agent" && item.recipientKind === "agent"
          && item.recipientId && !String(item.recipientId).startsWith("op_");
        const verify = verificationOf(item);

        // Reveal a genuinely new agent message with the typewriter: not seen
        // before AND created within the freshness window (scrollback/history and
        // the operator's own sends render instantly). Once an id is "in flight"
        // it keeps typing across polls until the Typewriter signals completion —
        // so a background refresh never snaps a mid-animation message to full.
        const ts = new Date(item.createdAt).getTime();
        const isFresh = Number.isFinite(ts) && now - ts <= NEW_MESSAGE_MS;
        const id = item.messageId;
        const done = id && animatedIds.current.has(id);
        const inFlight = id && typingNow.current.has(id);
        // Feeds are a one-way news stream — render them instantly, never typed.
        const startNew = animate && !isOp && !isFeed && id && isFresh && !done && !inFlight && !item.pending;
        if (startNew) typingNow.current.add(id);
        const shouldType = animate && !isOp && !isFeed && id && !done && (inFlight || startNew);

        // Plain agent rows take their stable hash colour as the rail; peer/feed/
        // operator/system rails come from their kind class (--sig).
        const rowStyle = !isOp && !isFeed && !isPeer && accent ? { "--sig": accent } : undefined;
        const nameClass = isOp ? " bubble-meta__name--op" : isFeed ? " bubble-meta__name--feed" : "";
        const nameStyle = !isOp && !isFeed && accent ? { color: accent } : undefined;
        return (
          <React.Fragment key={key}>
            {dayLabel ? <div className="day-divider"><span>{dayLabel}</span></div> : null}
          <div className={`bubble-row${isOp ? " bubble-row--op" : ""}${isPeer ? " bubble-row--peer" : ""}${isFeed ? " bubble-row--feed" : ""}${grouped ? " bubble-row--grouped" : ""}`} style={rowStyle}>
            {!isOp && !grouped ? <Avatar id={isFeed ? "feed" : item.senderId} label={isFeed ? "📰" : label} size={30} color={accent || (isFeed ? "#fbbf24" : undefined)} /> : <span className="bubble-spacer" />}
            <div className="bubble-col">
              <div className="bubble-meta">
                {grouped ? <span className="bubble-meta__dot" aria-hidden="true" /> : null}
                <span className={`bubble-meta__name${nameClass}`} style={nameStyle}>{isFeed ? `📰 ${label}` : label}</span>
                {isFeed ? <span className="bubble-meta__broadcast">broadcast</span> : null}
                {isPeer ? <span className="bubble-meta__peer">→ {nameFor(item.recipientId)}</span> : null}
                <span className="bubble-meta__time">{clockTime(item.createdAt)}</span>
                {verify ? (
                  <span
                    className={`bubble-meta__verify${verify === "verified" ? " bubble-meta__verify--ok" : ""}`}
                    title={verify === "verified" ? "Operator-signed — cryptographically verified" : "Relay-attested delivery"}
                  >
                    {verify === "verified" ? "✓" : "·"}
                  </span>
                ) : null}
              </div>
              <div className={`bubble${isOp ? " bubble--op" : ""}${isPeer ? " bubble--peer" : ""}${isFeed ? " bubble--feed" : ""}${item.pending ? " bubble--pending" : ""}${item.text ? "" : " bubble--media"}`}>
                {item.text ? (
                  <div className="bubble__text">
                    {shouldType ? (
                      <Typewriter
                        text={item.text}
                        onTick={stickToBottom}
                        onDone={() => {
                          typingNow.current.delete(id);
                          animatedIds.current.add(id);
                        }}
                      />
                    ) : (
                      <MentionText text={item.text} names={mentionNames} />
                    )}
                  </div>
                ) : null}
                {item.attachments?.length ? (
                  <AttachmentList token={token} attachments={item.attachments} onImageLoad={stickToBottom} />
                ) : null}
                {isOp && item.status ? (
                  <div className="bubble__footer">
                    <DeliveryTicks status={item.status} deliveredN={item.deliveredN} ackedN={item.ackedN} />
                  </div>
                ) : null}
              </div>
            </div>
            {item.messageId ? (
              <button
                type="button"
                className="bubble-reply"
                title="Reply to this message"
                aria-label="Reply"
                onClick={() => onReply({ messageId: item.messageId, text: item.text || "(attachment)", label })}
              >
                ↩
              </button>
            ) : null}
          </div>
          </React.Fragment>
        );
      })}

      {/* live typing indicators — one bubble per agent currently owed a reply */}
      {typingAgents.map((t) => {
        const accent = colorForAgent(t.agentId, settings);
        return (
          <div className="bubble-row bubble-row--typing" key={`typing-${t.agentId}`} style={{ "--sig": accent }}>
            <Avatar id={t.agentId} label={t.label} size={30} color={accent} />
            <div className="bubble-col">
              <div className="bubble-meta">
                <span className="bubble-meta__name" style={{ color: accent }}>{t.label}</span>
                <span className="bubble-meta__time">typing…</span>
              </div>
              <div className="bubble bubble--typing">
                <TypingDots color={accent} animated={settings.typingAnimation} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ============================ Right-rail tabs ============================ */

function ApprovalsTab({ approvals, initialized, onApprove, onReject, onTrace }) {
  if (!initialized) return <Skeleton count={3} height="80px" />;
  if (!approvals.length) return <EmptyState title="Queue clear">No pending approvals.</EmptyState>;
  return (
    <div className="cards">
      {approvals.map((a) => (
        <article className="rcard" key={a.id}>
          <div className="rcard__head">
            <span className="rcard__title">{a.summary}</span>
            <Badge>{a.risk_level}</Badge>
          </div>
          <div className="rcard__meta">{a.display_name || a.agent_id} · {a.action_type}</div>
          <div className="rcard__meta mono">{relativeTime(a.requested_at)}</div>
          <div className="rcard__actions">
            <button className="button button--sm" onClick={() => onApprove(a.id)}>Approve</button>
            <button className="button button--sm button--danger" onClick={() => onReject(a.id)}>Reject</button>
            {a.conversation_id ? <button className="button button--sm button--ghost" onClick={() => onTrace(a.conversation_id)}>Trace</button> : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function AgentTab({ agent, detail, rateLimits, onControl, onTrace }) {
  if (!agent) return <EmptyState title="No agent selected">Select an agent from the left rail to view controls, message history, and rate-limit activity.</EmptyState>;
  return (
    <div className="cards">
      <article className="rcard rcard--agent">
        <div className="rcard__agenthead">
          <Avatar id={agent.id} label={agent.display_name || agent.id} size={40} />
          <div>
            <div className="rcard__title">{agent.display_name || agent.id}</div>
            <div className="rcard__meta mono">{agent.id}</div>
          </div>
          <StatusDot status={agent.status} />
        </div>
        <div className="rcard__statline">
          <span><span className="mono">{agent.runtime || "custom"}</span></span>
          <span>seen {relativeTime(agent.last_seen_at)}</span>
        </div>
        <div className="rcard__actions">
          <button className="button button--sm button--warn" onClick={() => onControl(agent.id, "pause")}>Pause</button>
          <button className="button button--sm button--ghost" onClick={() => onControl(agent.id, "resume")}>Resume</button>
          <button className="button button--sm button--danger" onClick={() => onControl(agent.id, "quarantine")}>Quarantine</button>
        </div>
      </article>

      <div className="rsection-title">Recent messages</div>
      {detail?.recentMessages?.length ? (
        detail.recentMessages.slice(0, 8).map((m) => (
          <button className="line-row" key={m.id} onClick={() => onTrace(m.conversation_id)}>
            <span className="line-row__main">
              <span className="line-row__title">{m.message_type} <Badge>{m.status}</Badge></span>
              <span className="line-row__sub mono">{m.conversation_id}</span>
            </span>
            <span className="line-row__time">{relativeTime(m.created_at)}</span>
          </button>
        ))
      ) : (
        <div className="muted-note">No message history.</div>
      )}

      <div className="rsection-title">Rate-limit violations</div>
      {rateLimits.length ? (
        rateLimits.slice(0, 6).map((v) => (
          <div className="line-row line-row--static" key={v.id}>
            <span className="line-row__main">
              <span className="line-row__title">{v.message_count} / {v.limit_value} msgs</span>
              <span className="line-row__sub mono">{v.window_start}</span>
            </span>
            <Badge tone="warn">warn</Badge>
          </div>
        ))
      ) : (
        <div className="muted-note">No violations.</div>
      )}
    </div>
  );
}

function truncText(s, n) {
  if (typeof s !== "string") return String(s ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function FeedsTab({ feeds, agents, initialized, busy, onCreate, onPoll, onDelete, onSetSubscribers }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [subs, setSubs] = useState([]);
  const toggle = (id) => setSubs((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const submit = async () => {
    if (!name.trim() || !url.trim()) return;
    try {
      await onCreate({ name: name.trim(), url: url.trim(), subscriberAgentIds: subs });
      setName(""); setUrl(""); setSubs([]);
    } catch { /* error surfaced by parent */ }
  };

  // Editing the subscriber set of an already-saved feed.
  const [editingId, setEditingId] = useState(null);
  const [editSubs, setEditSubs] = useState([]);
  const startEdit = (f) => { setEditingId(f.id); setEditSubs((f.subscribers || []).map((s) => s.agent_id)); };
  const toggleEdit = (id) => setEditSubs((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const saveEdit = async (id) => {
    try { await onSetSubscribers(id, editSubs); setEditingId(null); } catch { /* surfaced by parent */ }
  };
  if (!initialized) return <Skeleton count={3} height="72px" />;
  return (
    <div className="cards">
      <div className="access-caption">
        Feeds (RSS/Atom) are polled and delivered to subscribed agents as <strong>non-waking</strong>
        {" "}context — they read them when active, spending no quota.
      </div>
      <div className="form">
        <label className="field"><span>Source name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hacker News" /></label>
        <label className="field"><span>Feed URL (RSS / Atom)</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/feed" /></label>
        <div className="field">
          <span>Deliver to</span>
          <div className="room-members">
            {agents.length ? agents.map((a) => (
              <label className="room-member" key={a.id}>
                <input type="checkbox" checked={subs.includes(a.id)} onChange={() => toggle(a.id)} />
                <span>{a.display_name || a.id}</span>
              </label>
            )) : <span className="muted">No agents enrolled yet.</span>}
          </div>
        </div>
        <button
          className="button button--sm button--primary button--block"
          disabled={!name.trim() || !url.trim() || busy === "create"}
          onClick={submit}
        >
          {busy === "create" ? "Adding…" : "Add feed"}
        </button>
      </div>
      {feeds.length ? (
        <div className="feed-list">
          {feeds.map((f) => (
            <article className="rcard feed-row" key={f.id}>
              <div className="feed-row__head">
                <div className="feed-row__id">
                  <div className="rcard__title">{f.name}</div>
                  <div className="rcard__meta mono feed-row__url">{f.url}</div>
                </div>
                <div className="feed-row__actions">
                  <button
                    className={`button button--sm ${editingId === f.id ? "button--primary" : "button--ghost"}`}
                    onClick={() => (editingId === f.id ? setEditingId(null) : startEdit(f))}
                  >
                    Subscribers
                  </button>
                  <button className="button button--sm button--ghost" disabled={busy === f.id} onClick={() => onPoll(f.id)}>{busy === f.id ? "…" : "Poll"}</button>
                  <button className="button button--sm button--danger" onClick={() => onDelete(f.id)} aria-label="Delete feed">×</button>
                </div>
              </div>
              <div className="feed-row__stats">
                {f.subscribers?.length ?? 0} subscriber{(f.subscribers?.length ?? 0) === 1 ? "" : "s"} · {f.item_count ?? 0} items · {f.last_polled_at ? `polled ${relativeTime(f.last_polled_at)}` : "not polled yet"}
              </div>
              {editingId === f.id ? (
                <div className="feed-row__edit">
                  <div className="room-members">
                    {agents.length ? agents.map((a) => (
                      <label className="room-member" key={a.id}>
                        <input type="checkbox" checked={editSubs.includes(a.id)} onChange={() => toggleEdit(a.id)} />
                        <span>{a.display_name || a.id}</span>
                      </label>
                    )) : <span className="muted">No agents enrolled yet.</span>}
                  </div>
                  <div className="feed-row__edit-actions">
                    <button className="button button--sm button--ghost" onClick={() => setEditingId(null)}>Cancel</button>
                    <button
                      className="button button--sm button--primary"
                      disabled={busy === `subs-${f.id}`}
                      onClick={() => saveEdit(f.id)}
                    >
                      {busy === `subs-${f.id}` ? "Saving…" : "Save subscribers"}
                    </button>
                  </div>
                </div>
              ) : f.subscribers?.length ? (
                <div className="feed-row__subs">
                  {f.subscribers.map((s) => (
                    <span className="feed-sub-chip" key={s.agent_id}>{s.display_name || s.agent_id}</span>
                  ))}
                </div>
              ) : (
                <div className="feed-row__subs feed-row__subs--empty muted">No subscribers — add some so agents receive it.</div>
              )}
            </article>
          ))}
        </div>
      ) : (
        <EmptyState title="No feeds yet">Add a source above to keep your agents current.</EmptyState>
      )}
    </div>
  );
}

function formatActivity(e, nameOf) {
  const p = e.payload || {};
  const actor = e.actor_kind === "operator" ? "Operator" : e.actor_name || e.actor_id || "system";
  const target = e.resource_name || e.resource_id || "";
  switch (e.event_type) {
    case "message.queued": {
      let rcpt;
      if (p.recipient_kind === "broadcast") rcpt = "the fleet";
      else if (p.recipient_kind === "room") rcpt = "a room";
      else rcpt = nameOf(p.recipient_id) || "a teammate";
      const text = p.text ? ` — “${truncText(p.text, 90)}”` : "";
      return { who: actor, line: `→ ${rcpt} (${p.message_type || "msg"})${text}` };
    }
    case "agent.trust_changed":
      return { who: target, line: `operator trust ${p.operator_trusted ? "ON" : "OFF"}` };
    case "agent.peer_autoreply_changed":
      return { who: target, line: `delegation ${p.peer_autoreply ? `ON · budget ${p.peer_turn_budget}` : "OFF"}` };
    case "room.created": {
      const roomName = (typeof p.name === "string" && p.name.trim()) || target || "untitled";
      return { who: "Operator", line: `created room “${roomName}”${Array.isArray(p.members) ? ` · ${p.members.length} members` : ""}` };
    }
    case "room.deleted":
      return { who: "Operator", line: "deleted a room" };
    default:
      return { who: actor, line: humanizeEvent(e.event_type, p) };
  }
}

function ActivityTab({ events, agents, initialized, filter, onFilter, onOpenConversation }) {
  const nameMap = useMemo(() => {
    const m = new Map();
    (agents || []).forEach((a) => m.set(a.id, a.display_name || a.id));
    return m;
  }, [agents]);
  const nameOf = (id) => (id ? nameMap.get(id) || null : null);
  const filters = [["", "All"], ["message", "Messages"], ["room", "Rooms"], ["agent", "Changes"]];
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = (key) => setExpanded((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  // Consolidate the flat stream into a drill-down: one row per conversation (its
  // participants + latest activity), expandable to its events; non-conversation
  // events (trust/room/policy changes) collect under a "Fleet changes" group.
  const { convGroups, fleet } = useMemo(() => {
    const byConv = new Map();
    const fleetEvents = [];
    for (const e of events || []) {
      const actor = e.actor_kind === "operator" ? "Operator" : e.actor_name || nameOf(e.actor_id) || e.actor_id;
      if (e.conversation_id) {
        let g = byConv.get(e.conversation_id);
        if (!g) { g = { id: e.conversation_id, events: [], actors: new Set() }; byConv.set(e.conversation_id, g); }
        g.events.push(e);
        if (actor) g.actors.add(actor);
      } else {
        fleetEvents.push(e);
      }
    }
    const groups = [...byConv.values()].map((g) => ({
      ...g,
      latest: g.events[0],
      // headline the latest real message, not a delivery receipt
      latestMsg: g.events.find((e) => (e.event_type || "") === "message.queued") || g.events[0],
      count: g.events.length,
    }));
    groups.sort((a, b) => ((b.latest?.created_at || "") > (a.latest?.created_at || "") ? 1 : -1));
    return { convGroups: groups, fleet: fleetEvents };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, nameMap]);

  const eventRow = (e, size = 22) => {
    const { who, line } = formatActivity(e, nameOf);
    return (
      <div className="activity__row" key={e.id}>
        <Avatar id={e.actor_id || e.event_type} label={who} size={size} />
        <div className="activity__body">
          <div className="activity__line"><strong>{who}</strong> {line}</div>
          <div className="activity__time">{relativeTime(e.created_at)}</div>
        </div>
      </div>
    );
  };

  if (!initialized) return <Skeleton count={5} height="46px" />;
  return (
    <div className="activity">
      <div className="activity__filters">
        {filters.map(([val, label]) => (
          <button key={val || "all"} className={`chip${filter === val ? " chip--active" : ""}`} onClick={() => onFilter(val)}>{label}</button>
        ))}
      </div>
      {convGroups.length || fleet.length ? (
        <div className="actgroups">
          {convGroups.map((g) => {
            const open = expanded.has(g.id);
            const { who, line } = formatActivity(g.latestMsg, nameOf);
            const names = [...g.actors];
            const title = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "") || "Conversation";
            return (
              <div className={`actgroup${open ? " actgroup--open" : ""}`} key={g.id}>
                <div className="actgroup__head">
                  <button className="actgroup__chev" onClick={() => toggle(g.id)} aria-expanded={open} aria-label={open ? "Collapse" : "Expand"}>›</button>
                  <button className="actgroup__main" onClick={() => onOpenConversation?.(g.id)} title="Open conversation">
                    <span className="conv-row__dot" style={{ background: colorForId(g.id) }} />
                    <span className="actgroup__text">
                      <span className="actgroup__title">{title}</span>
                      <span className="actgroup__preview"><strong>{who}</strong> {line}</span>
                    </span>
                    <span className="actgroup__meta">
                      <span className="actgroup__count">{g.count}</span>
                      <span className="actgroup__time">{relativeTime(g.latest?.created_at)}</span>
                    </span>
                  </button>
                </div>
                {open ? <div className="actgroup__events">{g.events.map((e) => eventRow(e))}</div> : null}
              </div>
            );
          })}
          {fleet.length ? (
            <div className={`actgroup${expanded.has("__fleet__") ? " actgroup--open" : ""}`}>
              <div className="actgroup__head">
                <button className="actgroup__chev" onClick={() => toggle("__fleet__")} aria-expanded={expanded.has("__fleet__")} aria-label="Toggle fleet changes">›</button>
                <button className="actgroup__main" onClick={() => toggle("__fleet__")}>
                  <span className="conv-row__dot" style={{ background: "var(--muted)" }} />
                  <span className="actgroup__text">
                    <span className="actgroup__title">Fleet changes</span>
                    <span className="actgroup__preview">trust, rooms, policies &amp; control</span>
                  </span>
                  <span className="actgroup__meta"><span className="actgroup__count">{fleet.length}</span></span>
                </button>
              </div>
              {expanded.has("__fleet__") ? <div className="actgroup__events">{fleet.map((e) => eventRow(e))}</div> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyState title="No activity yet">Fleet messages, hand-offs, and changes will stream here.</EmptyState>
      )}
    </div>
  );
}

// The "Needs You" queue: the operator's single ranked to-do list of things
// that actually need a human — dead/degraded models, stalled hand-offs, and
// undeliverable messages. Empty = genuinely nothing on fire.
const ATTN_GLYPH = { agent_down: "⏻", agent_degraded: "▽", stalled: "⏸", dead_letter: "✉" };
const ATTN_TONE = { critical: "danger", warn: "warn" };

function AttentionTab({ data, initialized, onSelectAgent, onOpenConversation }) {
  if (!initialized) return <Skeleton count={3} height="64px" />;
  const items = data?.items || [];
  if (!items.length) {
    return <EmptyState title="All clear">Nothing needs you right now — no down agents, stalled hand-offs, or dropped messages.</EmptyState>;
  }
  const counts = data.counts || { critical: 0, warn: 0 };
  return (
    <div className="cards">
      <div className="health-summary">
        <StatChip label="Critical" value={counts.critical || 0} tone={counts.critical ? "danger" : "muted"} />
        <StatChip label="Warnings" value={counts.warn || 0} tone={counts.warn ? "warn" : "muted"} />
      </div>
      {items.map((it) => {
        const tone = ATTN_TONE[it.severity] || "muted";
        const clickable = Boolean(it.conversationId || it.agentId);
        const onClick = () => {
          if (it.conversationId) onOpenConversation?.(it.conversationId);
          else if (it.agentId) onSelectAgent?.(it.agentId);
        };
        return (
          <article
            className={`rcard attn-item attn-item--${tone}${clickable ? " attn-item--click" : ""}`}
            key={it.id}
            onClick={clickable ? onClick : undefined}
            role={clickable ? "button" : undefined}
            tabIndex={clickable ? 0 : undefined}
          >
            <div className="attn-item__head">
              <span className={`attn-item__glyph attn-item__glyph--${tone}`} aria-hidden="true">{ATTN_GLYPH[it.kind] || "•"}</span>
              <span className="attn-item__title">{it.title}</span>
              <Badge tone={tone}>{it.severity === "critical" ? "CRITICAL" : "WARN"}</Badge>
            </div>
            <div className="attn-item__detail">{it.detail}</div>
            <div className="attn-item__foot">
              <span className="mono muted">{it.kind.replace("_", " ")}</span>
              {it.at ? <span className="muted">· {relativeTime(it.at)}</span> : null}
              {clickable ? <span className="attn-item__cta">{it.conversationId ? "open thread ›" : "view agent ›"}</span> : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

// Fleet-health verdict → visual tone. The verdict is computed server-side
// (deriveAgentHealth) combining connection liveness with the model's real
// turn outcomes, so a connected-but-brain-dead agent lands on "down", not "ok".
const HEALTH_TONE = { down: "danger", degraded: "warn", ok: "ok" };
const HEALTH_RANK = { down: 0, degraded: 1, ok: 2 };
const HEALTH_LABEL = { down: "DOWN", degraded: "DEGRADED", ok: "OK" };

// Defensive fallback for a relay that predates the verdict (old build): derive
// a coarse level from the raw fields so the board never renders blank.
function agentHealth(a) {
  if (a.health && a.health.level) return a.health;
  if (a.status === "quarantined" || a.status === "revoked") return { level: "down", reason: a.status };
  if ((a.consecutive_missed_heartbeats || 0) > 0 || !a.last_heartbeat_at) return { level: "degraded", reason: "missing heartbeats" };
  return { level: "ok", reason: "healthy" };
}

function HealthTab({ agents, initialized }) {
  if (!initialized) return <Skeleton count={3} height="80px" />;
  if (!agents.length) return <EmptyState title="No agents">Enroll an agent to see fleet health here.</EmptyState>;

  // Sort worst-first so anything needing attention sits at the top of the board.
  const ranked = [...agents].sort((x, y) => {
    const hx = agentHealth(x), hy = agentHealth(y);
    const d = (HEALTH_RANK[hx.level] ?? 3) - (HEALTH_RANK[hy.level] ?? 3);
    return d !== 0 ? d : String(x.display_name || x.id).localeCompare(String(y.display_name || y.id));
  });
  const counts = ranked.reduce((acc, a) => { acc[agentHealth(a).level] = (acc[agentHealth(a).level] || 0) + 1; return acc; }, {});

  return (
    <div className="cards">
      <div className="health-summary">
        <StatChip label="OK" value={counts.ok || 0} tone="ok" />
        <StatChip label="Degraded" value={counts.degraded || 0} tone="warn" />
        <StatChip label="Down" value={counts.down || 0} tone={counts.down ? "danger" : "muted"} />
      </div>
      {ranked.map((a) => {
        const h = agentHealth(a);
        const tone = HEALTH_TONE[h.level] || "muted";
        const model = a.metrics?.model;
        const provider = a.metrics?.provider;
        const turnHealth = a.metrics?.turn_health;
        const errs = Number(a.metrics?.model_errors_1h ?? 0) || 0;
        const active = a.active_conversations?.length || 0;
        return (
          <article className={`rcard health-row health-row--${tone}`} key={a.id}>
            <div className="access-row__head">
              <Avatar id={a.id} label={a.display_name || a.id} size={34} />
              <div className="access-row__id">
                <div className="rcard__title">{a.display_name || a.id}</div>
                <div className="rcard__meta">
                  <span className="mono">{a.runtime || "custom"}</span>
                  {model ? (
                    <> · <span className="mono">{model}</span>{provider ? <span className="muted"> ({provider})</span> : null}</>
                  ) : (
                    <span className="muted"> · model —</span>
                  )}
                </div>
              </div>
              <Badge tone={tone}>{HEALTH_LABEL[h.level] || "?"}</Badge>
            </div>
            {h.level !== "ok" && h.reason ? (
              <div className={`health-reason health-reason--${tone}`}>▸ {h.reason}</div>
            ) : null}
            <div className="health-row__stats">
              <span className="health-stat"><strong>{a.sent_1h ?? 0}</strong> sent</span>
              <span className="health-stat"><strong>{a.received_1h ?? 0}</strong> recv</span>
              <span className="muted">/1h</span>
              <span className="health-row__spacer" />
              <span className="health-stat">{active} active</span>
              <span className="muted">beat {relativeTime(a.last_heartbeat_at)}</span>
            </div>
            <div className="health-row__flags">
              {turnHealth ? (
                <Badge tone={turnHealth === "down" ? "danger" : turnHealth === "degraded" ? "warn" : "ok"}>
                  turns {turnHealth}{errs ? ` · ${errs} err/1h` : ""}
                </Badge>
              ) : (
                <Badge tone="muted" title="Agent plugin predates turn telemetry">turns —</Badge>
              )}
              {a.operator_trusted ? <Badge tone="ok">trusted</Badge> : null}
              {a.peer_autoreply ? <Badge>delegation · {a.peer_turn_budget}</Badge> : <Badge>solo</Badge>}
            </div>
          </article>
        );
      })}
    </div>
  );
}

// Health bucket for a node ring: red if quarantined/revoked, amber if it's
// missing heartbeats (or never sent one), green otherwise.
function topoHealth(a) {
  if (a.status === "quarantined" || a.status === "revoked") return "danger";
  if ((a.consecutive_missed_heartbeats || 0) > 0 || !a.last_heartbeat_at) return "warn";
  return "ok";
}
const topoInitials = (name) => String(name || "?").slice(0, 2).toUpperCase();

/* Fleet topology map: a radial collaboration graph. The relay sits at the hub;
   each agent is a node placed around it (initials inside, ring coloured by health,
   size by throughput). Lines between agents are who actually messaged whom in the
   window — thicker = more. Faint spokes anchor every agent to the hub so isolated
   ones still read. Pure SVG, no chart dependency. Hovering a node isolates its
   links; clicking focuses that agent. A roster below doubles as the label key. */
function TopologyTab({ data, initialized, onSelect, settings }) {
  const [hovered, setHovered] = useState("");
  const nodes = data?.nodes || [];
  const edges = data?.edges || [];

  // Stable radial layout keyed on the agent set, so polling updates counts/health
  // without the map jumping around. Start at the top, go clockwise.
  const W = 340;
  const CX = 170;
  const CY = 150;
  const RING = 112;
  const positions = useMemo(() => {
    const ids = nodes.map((n) => n.id).sort();
    const pos = new Map();
    const n = ids.length || 1;
    ids.forEach((id, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      pos.set(id, { x: CX + RING * Math.cos(angle), y: CY + RING * Math.sin(angle) });
    });
    return pos;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.map((n) => n.id).sort().join("|")]);

  const degree = useMemo(() => {
    const d = new Map();
    for (const e of edges) {
      d.set(e.source, (d.get(e.source) || 0) + e.count);
      d.set(e.target, (d.get(e.target) || 0) + e.count);
    }
    return d;
  }, [edges]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const adjacency = useMemo(() => {
    const m = new Map();
    for (const e of edges) {
      if (!m.has(e.source)) m.set(e.source, new Set());
      if (!m.has(e.target)) m.set(e.target, new Set());
      m.get(e.source).add(e.target);
      m.get(e.target).add(e.source);
    }
    return m;
  }, [edges]);
  // On hover, spotlight the agent AND its direct collaborators (so a lit link never
  // dead-ends at a dimmed node); everything else fades back.
  const incident = (id) => !hovered || hovered === id || Boolean(adjacency.get(hovered)?.has(id));
  const edgeLit = (e) => !hovered || e.source === hovered || e.target === hovered;

  // If the hovered agent leaves the node set (e.g. removed on a poll), its
  // onMouseLeave can never fire — clear the hover so the map doesn't stay dimmed.
  useEffect(() => {
    if (hovered && !byId.has(hovered)) setHovered("");
  }, [byId, hovered]);

  if (!initialized) return <Skeleton count={1} height="320px" />;
  if (!nodes.length) return <EmptyState title="No agents">Enroll agents to see the fleet map here.</EmptyState>;

  return (
    <div className="topo">
      <div className="access-caption">
        Who's working with whom — agent-to-agent message flow over the last {data.window_minutes || 60} min.
        Thicker links = more traffic; ring colour = health; size = throughput.
      </div>

      <svg className="topo-svg" viewBox={`0 0 ${W} 300`} role="img" aria-label="Fleet collaboration map">
        {/* faint hub spokes first, under everything */}
        {nodes.map((a) => {
          const p = positions.get(a.id);
          if (!p) return null;
          return (
            <line
              key={`spoke-${a.id}`}
              className="topo-spoke"
              x1={CX} y1={CY} x2={p.x} y2={p.y}
              style={{ opacity: incident(a.id) ? 0.5 : 0.12 }}
            />
          );
        })}

        {/* collaboration edges */}
        {edges.map((e) => {
          const s = positions.get(e.source);
          const t = positions.get(e.target);
          if (!s || !t) return null;
          const sa = byId.get(e.source);
          const ta = byId.get(e.target);
          return (
            <line
              key={`edge-${e.source}-${e.target}`}
              className="topo-edge"
              x1={s.x} y1={s.y} x2={t.x} y2={t.y}
              strokeWidth={1.2 + Math.min(e.count, 12) * 0.6}
              style={{ opacity: edgeLit(e) ? 0.85 : 0.1 }}
            >
              <title>{`${sa?.display_name || e.source} ↔ ${ta?.display_name || e.target} · ${e.count} msg${e.count === 1 ? "" : "s"}`}</title>
            </line>
          );
        })}

        {/* relay hub */}
        <g className="topo-hub">
          <circle cx={CX} cy={CY} r={22} />
          <text x={CX} y={CY} dy="0.35em" textAnchor="middle">EKHO</text>
        </g>

        {/* agent nodes */}
        {nodes.map((a) => {
          const p = positions.get(a.id);
          if (!p) return null;
          const tput = (a.sent_1h ?? 0) + (a.received_1h ?? 0);
          const r = 13 + Math.min(tput, 24) * 0.42;
          const health = topoHealth(a);
          return (
            <g
              key={`node-${a.id}`}
              className="topo-node"
              transform={`translate(${p.x}, ${p.y})`}
              style={{ opacity: incident(a.id) ? 1 : 0.28, cursor: "pointer" }}
              onMouseEnter={() => setHovered(a.id)}
              onMouseLeave={() => setHovered("")}
              onClick={() => onSelect?.(a.id)}
            >
              <circle className={`topo-node__ring topo-node__ring--${health}`} r={r} />
              <text className="topo-node__label" dy="0.35em" textAnchor="middle" style={{ fill: colorForAgent(a.id, settings) }}>
                {topoInitials(a.display_name || a.id)}
              </text>
              <title>{`${a.display_name || a.id} · ${a.runtime || "custom"}${a.metrics?.model ? ` · ${a.metrics.model}` : ""}\n${a.sent_1h ?? 0} sent / ${a.received_1h ?? 0} recv (1h)`}</title>
            </g>
          );
        })}
      </svg>

      <div className="topo-roster">
        {nodes.map((a) => {
          const links = degree.get(a.id) || 0;
          const health = topoHealth(a);
          return (
            <button
              key={`roster-${a.id}`}
              className={`topo-roster__row${hovered === a.id ? " is-hot" : ""}`}
              onMouseEnter={() => setHovered(a.id)}
              onMouseLeave={() => setHovered("")}
              onClick={() => onSelect?.(a.id)}
            >
              <span className={`topo-dot topo-dot--${health}`} />
              <span className="topo-roster__name">{a.display_name || a.id}</span>
              <span className="topo-roster__stat muted">{a.sent_1h ?? 0}↑ {a.received_1h ?? 0}↓</span>
              <span className="topo-roster__links">{links ? `${links} link${links === 1 ? "" : "s"}` : "idle"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PeerControl({ agent, pending, onSet }) {
  const enabled = Boolean(agent.peer_autoreply);
  const savedBudget = agent.peer_turn_budget ?? 6;
  const [budget, setBudget] = useState(savedBudget);
  useEffect(() => { setBudget(savedBudget); }, [savedBudget]);

  const commitBudget = () => {
    const next = Math.max(1, Math.min(50, Math.trunc(Number(budget) || savedBudget)));
    setBudget(next);
    if (enabled && next !== savedBudget) onSet(agent.id, true, next);
  };

  return (
    <div className="access-row__peer">
      <label className={`toggle access-row__toggle${pending ? " access-row__toggle--pending" : ""}`}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending}
          onChange={(e) => onSet(agent.id, e.target.checked)}
        />
        <span>Agent-to-agent delegation</span>
        {pending ? <span className="access-row__spinner" aria-label="Saving" /> : null}
      </label>
      {enabled ? (
        <div className="access-row__budget">
          <span className="access-row__budget-label">Budget</span>
          <input
            className="access-row__budget-input"
            type="number"
            min={1}
            max={50}
            value={budget}
            disabled={pending}
            onChange={(e) => setBudget(e.target.value)}
            onBlur={commitBudget}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
          />
          <span className="access-row__budget-unit">turns / conversation</span>
        </div>
      ) : null}
    </div>
  );
}

function AccessTab({ agents, initialized, trustPending, onSetTrust, peerPending, onSetPeerAutoreply }) {
  if (!initialized) return <Skeleton count={3} height="64px" />;
  if (!agents.length) return <EmptyState title="No agents">Enroll an agent to grant it an operator-trusted channel.</EmptyState>;
  return (
    <div className="cards">
      <div className="access-caption">
        <strong>Operator-trusted channel:</strong> when ON, this agent recognizes the console operator as its verified principal (risky actions still require approval).<br />
        <strong>Agent-to-agent delegation:</strong> when ON, teammates can wake this agent to collaborate, bounded by the per-conversation turn budget.
      </div>
      {agents.map((agent) => {
        const trusted = Boolean(agent.operator_trusted);
        const pending = trustPending === agent.id;
        return (
          <article className="rcard access-row" key={agent.id}>
            <div className="access-row__head">
              <Avatar id={agent.id} label={agent.display_name || agent.id} size={34} />
              <div className="access-row__id">
                <div className="rcard__title">{agent.display_name || agent.id}</div>
                <div className="rcard__meta mono">{agent.id}</div>
              </div>
              <StatusDot status={agent.status} title={agent.status} />
            </div>
            <label className={`toggle access-row__toggle${pending ? " access-row__toggle--pending" : ""}`}>
              <input
                type="checkbox"
                checked={trusted}
                disabled={pending}
                onChange={(e) => onSetTrust(agent.id, e.target.checked)}
              />
              <span>Operator-trusted channel</span>
              {pending ? <span className="access-row__spinner" aria-label="Saving" /> : null}
            </label>
            <PeerControl agent={agent} pending={peerPending === agent.id} onSet={onSetPeerAutoreply} />
          </article>
        );
      })}
    </div>
  );
}

function DeadLettersTab({ deadLetters, total, initialized, expanded, onExpand, onTrace }) {
  if (!initialized) return <Skeleton count={3} height="70px" />;
  if (!deadLetters.length) return <EmptyState title="All delivered">No dead letters. Every message reached its recipient.</EmptyState>;
  return (
    <div className="cards">
      <div className="rsection-title">{total} dead letter{total === 1 ? "" : "s"}</div>
      {deadLetters.map((dl) => (
        <article className="rcard" key={dl.id}>
          <div className="rcard__head">
            <span className="rcard__title">{dl.message_type}</span>
            <Badge tone="warn">retry {dl.retry_count}</Badge>
          </div>
          <div className="rcard__meta mono">{dl.sender_agent_id} → {dl.recipient_agent_id}</div>
          <div className="rcard__meta">{dl.failure_reason} · {relativeTime(dl.dead_lettered_at)}</div>
          <div className="rcard__actions">
            <button className="button button--sm button--ghost" onClick={() => onExpand(dl)}>{expanded?.id === dl.id ? "Collapse" : "Expand"}</button>
            {dl.conversation_id ? <button className="button button--sm button--ghost" onClick={() => onTrace(dl.conversation_id)}>Trace</button> : null}
          </div>
          {expanded?.id === dl.id ? <pre className="code-block">{JSON.stringify(expanded, null, 2)}</pre> : null}
        </article>
      ))}
    </div>
  );
}

function PoliciesTab({ policies, initialized, onCreate, onEdit, onDelete }) {
  return (
    <div className="cards">
      <button className="button button--sm button--block" onClick={onCreate}>Create policy</button>
      {!initialized ? (
        <Skeleton count={2} height="70px" />
      ) : policies.length ? (
        policies.map((p) => {
          const rule = typeof p.rule_json === "string" ? JSON.parse(p.rule_json) : p.rule_json || {};
          return (
            <article className="rcard" key={p.id}>
              <div className="rcard__head">
                <span className="rcard__title">{p.name}</span>
                <Badge tone={p.enabled ? "ok" : ""}>{p.enabled ? "on" : "off"}</Badge>
              </div>
              <div className="rcard__meta">
                {p.scope_kind}{p.scope_id ? `: ${p.scope_id}` : ""} · <Badge>{rule?.action || "allow"}</Badge>
              </div>
              <div className="rcard__actions">
                <button className="button button--sm button--ghost" onClick={() => onEdit(p)}>Edit</button>
                <button className="button button--sm button--danger" onClick={() => onDelete(p.id)}>Delete</button>
              </div>
            </article>
          );
        })
      ) : (
        <EmptyState title="No policies">Create one to control message routing across the fleet.</EmptyState>
      )}
    </div>
  );
}

function RoomModal({ agents, rooms, saving, onCreate, onDelete, onClose }) {
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState([]);
  const toggle = (id) =>
    setMemberIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const submit = () => {
    if (!name.trim()) return;
    onCreate(name.trim(), memberIds);
    setName("");
    setMemberIds([]);
  };
  return (
    <Modal
      title="Rooms"
      onClose={onClose}
      actions={[{ label: "Close", onClick: onClose, variant: "ghost" }]}
    >
      <div className="room-caption">
        A room is a named conversation with a chosen set of agents — message it to
        run a project with just those teammates instead of the whole fleet.
      </div>
      <div className="form">
        <label className="field">
          <span>New room name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. API Redesign" />
        </label>
        <div className="field">
          <span>Members</span>
          <div className="room-members">
            {agents.length ? (
              agents.map((a) => (
                <label className="room-member" key={a.id}>
                  <input type="checkbox" checked={memberIds.includes(a.id)} onChange={() => toggle(a.id)} />
                  <span>{a.display_name || a.id}</span>
                </label>
              ))
            ) : (
              <span className="muted">No agents enrolled yet.</span>
            )}
          </div>
        </div>
        <button
          className="button button--sm button--primary button--block"
          disabled={!name.trim() || saving}
          onClick={submit}
        >
          {saving ? "Creating…" : "Create room"}
        </button>
      </div>
      {rooms.length ? (
        <div className="room-list">
          {rooms.map((r) => (
            <div className="room-list__item" key={r.id}>
              <div className="room-list__meta">
                <strong># {r.name}</strong>
                <span className="muted"> · {r.members?.length ?? 0} member{(r.members?.length ?? 0) === 1 ? "" : "s"}</span>
              </div>
              <button className="button button--sm button--danger" onClick={() => onDelete(r.id)}>Delete</button>
            </div>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}

function PolicyModal({ editing, form, setForm, status, onClose, onSave }) {
  return (
    <Modal
      title={editing ? "Edit policy" : "Create policy"}
      onClose={onClose}
      actions={[
        { label: "Cancel", onClick: onClose, variant: "ghost" },
        { label: editing ? "Save changes" : "Create", onClick: onSave, variant: "primary" },
      ]}
    >
      <div className="form">
        <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></label>
        <label className="field">
          <span>Scope</span>
          <select value={form.scope_kind} onChange={(e) => setForm((f) => ({ ...f, scope_kind: e.target.value }))}>
            <option value="fleet">Fleet-wide</option>
            <option value="agent">Agent-specific</option>
          </select>
        </label>
        {form.scope_kind === "agent" && (
          <label className="field"><span>Scope agent ID</span><input value={form.scope_id} onChange={(e) => setForm((f) => ({ ...f, scope_id: e.target.value }))} placeholder="agent_…" /></label>
        )}
        <label className="field">
          <span>Action</span>
          <select value={form.rule.action} onChange={(e) => setForm((f) => ({ ...f, rule: { ...f.rule, action: e.target.value } }))}>
            <option value="deny">Deny</option>
            <option value="allow">Allow</option>
          </select>
        </label>
        <label className="field">
          <span>Message types (comma-separated)</span>
          <input
            value={(Array.isArray(form.rule.conditions.message_type) ? form.rule.conditions.message_type : []).join(", ")}
            onChange={(e) => {
              const types = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
              setForm((f) => ({ ...f, rule: { ...f.rule, conditions: { ...f.rule.conditions, message_type: types.length ? types : undefined } } }));
            }}
            placeholder="direct, broadcast, alert"
          />
        </label>
        <label className="field">
          <span>Sender agent IDs (comma-separated)</span>
          <input
            value={(Array.isArray(form.rule.conditions.sender_agent_id) ? form.rule.conditions.sender_agent_id : []).join(", ")}
            onChange={(e) => {
              const ids = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
              setForm((f) => ({ ...f, rule: { ...f.rule, conditions: { ...f.rule.conditions, sender_agent_id: ids.length ? ids : undefined } } }));
            }}
            placeholder="agent_…"
          />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
          <span>Enabled</span>
        </label>
        {status ? <StatusMessage tone="error">{status}</StatusMessage> : null}
      </div>
    </Modal>
  );
}

function cap(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}
