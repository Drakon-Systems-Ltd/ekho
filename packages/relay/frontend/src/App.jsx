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
  setAgentTrust,
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
import { useAutoRefresh, useNow } from "./hooks";

const POLL_INTERVAL_MS = 5000;
const TIMELINE_LIMIT = 100;

/* Map a raw conversation event into a renderable chat item. Operator messages
   carry their text in the event payload; agent/system events are rendered as
   readable activity lines derived from the event type + payload. */
function describeEvent(event) {
  const payload = parsePayload(event.payload_json);
  const type = event.event_type || "";
  const isOperator = event.actor_kind === "operator" || payload.sender_label === "Operator";
  const isMessage = type === "message.queued";
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
    kind: isSystem ? "system" : "message",
    side: isOperator ? "operator" : "agent",
    senderId: event.actor_id || "system",
    // Display name is resolved later from the live agents map; fall back to the id.
    senderLabel: isOperator ? "Operator" : event.actor_id || "system",
    messageId: event.resource_kind === "message" ? event.resource_id || "" : "",
    recipientKind,
    recipientId,
    text,
    attachments,
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
  const [rightTab, setRightTab] = useState("approvals");
  const [showSystem, setShowSystem] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [composerRecipient, setComposerRecipient] = useState("broadcast");
  const [optimistic, setOptimistic] = useState([]); // pending operator messages
  const [sending, setSending] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]); // [{id, filename, mime, size_bytes}]
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [composerError, setComposerError] = useState("");
  const fileInputRef = useRef(null);
  const [trustPending, setTrustPending] = useState(""); // agentId whose trust toggle is in-flight

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
  const markInit = (key) => {
    if (!initialized.current[key]) {
      initialized.current[key] = true;
      forceTick((n) => n + 1);
    }
  };

  const healthyCount = useMemo(
    () => (overview.agents || []).filter((a) => a.status === "healthy").length,
    [overview.agents]
  );

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
    // drop optimistic items that the server has now echoed back
    setOptimistic((items) => items.filter((o) => o.conversationId !== conversationId || !(result.events || []).some((e) => parsePayload(e.payload_json).text === o.text && e.actor_kind === "operator")));
  }

  async function refreshAgentDetail(agentId = selectedAgentId) {
    if (!session.token || !agentId) return;
    try {
      const detail = await getAgentDetail(session.token, agentId);
      setAgentDetail(detail);
    } catch (error) {
      handleApiError(error, { allowSessionReset: true });
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
    refreshAgentDetail(agentId);
    refreshAgentRateLimits(agentId);
    if (agentId !== "broadcast") setComposerRecipient(agentId);
  }

  function selectConversation(conversationId) {
    if (!conversationId) return;
    setSelectedConversationId(conversationId);
    setTimelineEvents([]);
    refreshTimeline(conversationId).catch((error) => handleApiError(error, { allowSessionReset: true }));
  }

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
    const recipient = composerRecipient || "broadcast";
    const convId = selectedConversationId || undefined;
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
    setSending(true);
    try {
      const res = await sendOperatorMessage(session.token, {
        recipientAgentId: recipient,
        text,
        conversationId: convId,
        attachmentIds: attachmentIds.length ? attachmentIds : undefined,
      });
      const newConvId = res.conversation_id;
      // bind the optimistic item to the resolved conversation id
      setOptimistic((items) => items.map((o) => (o.id === optimisticItem.id ? { ...o, conversationId: newConvId } : o)));
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
    Promise.all([refreshOverview(), refreshAgents(), refreshApprovals(), refreshPolicies(), refreshDeadLetters()]).catch((error) =>
      handleApiError(error, { allowSessionReset: true })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.token]);

  useEffect(() => {
    if (!session.token) return;
    refreshAgents().catch((error) => handleApiError(error, { allowSessionReset: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSearch, agentStatusFilter]);

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
        selectedConversationId ? refreshTimeline(selectedConversationId) : Promise.resolve(),
        selectedAgentId ? refreshAgentDetail(selectedAgentId) : Promise.resolve(),
        selectedAgentId ? refreshAgentRateLimits(selectedAgentId) : Promise.resolve(),
      ]).catch((error) => handleApiError(error, { allowSessionReset: true }));
    },
    [session.token, selectedConversationId, selectedAgentId, agentSearch, agentStatusFilter]
  );

  /* ---------------- derived: conversation list + chat items ---------------- */

  const conversationList = useMemo(() => {
    // derive recent conversations from overview events + agent detail messages
    const map = new Map();
    const consider = (convId, ts, preview) => {
      if (!convId) return;
      const existing = map.get(convId);
      if (!existing || (ts && ts > existing.ts)) {
        map.set(convId, { id: convId, ts: ts || existing?.ts || "", preview: preview || existing?.preview || "" });
      }
    };
    (overview.recentEvents || []).forEach((e) => {
      if (e.conversation_id) consider(e.conversation_id, e.created_at, humanizeEvent(e.event_type, {}));
    });
    (agentDetail?.recentMessages || []).forEach((m) => consider(m.conversation_id, m.created_at, `${m.message_type} message`));
    if (selectedConversationId && !map.has(selectedConversationId)) {
      map.set(selectedConversationId, { id: selectedConversationId, ts: "", preview: "" });
    }
    return Array.from(map.values()).sort((a, b) => (b.ts > a.ts ? 1 : -1)).slice(0, 25);
  }, [overview.recentEvents, agentDetail, selectedConversationId]);

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
    const fromEvents = (timelineEvents || []).map(describeEvent);
    const visible = showSystem ? fromEvents : fromEvents.filter((i) => i.kind === "message" || !isHeartbeatEvent(i.type));
    const pending = optimistic
      .filter((o) => o.conversationId === selectedConversationId)
      .map((o) => ({ kind: "message", side: "operator", senderId: "operator", senderLabel: "Operator", text: o.text, attachments: o.attachments || [], type: "message.queued", createdAt: o.createdAt, pending: true }));
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
    agents.forEach((a) => opts.push({ value: a.id, label: a.display_name || a.id }));
    return opts;
  }, [agents]);

  /* ---------------- login screen ---------------- */

  if (!session.token) {
    return (
      <div className="boot-screen">
        <form className="auth-card" onSubmit={handleLoginSubmit}>
          <div className="auth-card__brand">
            <span className="brand-mark">E</span>
            <div>
              <div className="brand-name">Ekho</div>
              <div className="brand-sub">by Drakon Systems · Operator Console</div>
            </div>
          </div>
          <p className="auth-card__lede">Sign in to monitor, steer, and message your private agent fleet.</p>
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
    <div className="app">
      <header className="appbar">
        <div className="appbar__brand">
          <span className="brand-mark">E</span>
          <div className="appbar__titles">
            <span className="brand-name">
              Ekho <span className="brand-by">by Drakon Systems</span>
            </span>
            <span className="appbar__sub">Operator Console · {session.fleetId}</span>
          </div>
        </div>
        <div className="appbar__right">
          <span className="sync-pill" title="Live — auto-syncing every 5s">
            <LiveDot active />
            synced
          </span>
          <button className="icon-button appbar__icon" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
            <GearIcon />
          </button>
          <button className="icon-button appbar__icon" onClick={() => setHelpOpen(true)} aria-label="Help" title="Help & setup">
            <HelpIcon />
          </button>
          <button className="button button--ghost button--sm" onClick={() => Promise.all([refreshOverview(), refreshAgents(), refreshApprovals(), selectedConversationId ? refreshTimeline() : Promise.resolve()]).catch((e) => handleApiError(e, { allowSessionReset: true }))}>
            Refresh
          </button>
          <button className="button button--ghost button--sm" onClick={clearStoredSession}>Log out</button>
        </div>
      </header>

      <div className="layout">
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
              <span>Agents</span>
              <span className="rail__count">{agentsTotal}</span>
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
                        <span className="mono">{agent.runtime || "custom"}</span> · {relativeTime(agent.last_seen_at)}
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
              <span>Conversations</span>
            </div>
            <div className="rail__list">
              {conversationList.length ? (
                conversationList.map((c) => (
                  <button
                    key={c.id}
                    className={`conv-row${c.id === selectedConversationId ? " conv-row--active" : ""}`}
                    onClick={() => selectConversation(c.id)}
                  >
                    <span className="conv-row__dot" style={{ background: colorForId(c.id) }} />
                    <span className="conv-row__main">
                      <span className="conv-row__id mono">{c.id}</span>
                      <span className="conv-row__preview">{c.preview || "Open conversation"}</span>
                    </span>
                    {c.ts ? <span className="conv-row__time">{relativeTime(c.ts)}</span> : null}
                  </button>
                ))
              ) : (
                <EmptyState>No recent conversations.</EmptyState>
              )}
            </div>
          </div>
        </aside>

        {/* CENTER — CHAT */}
        <main className="chat">
          <div className="chat__header">
            <div className="chat__heading">
              {selectedConversationId ? (
                <>
                  <span className="conv-row__dot" style={{ background: colorForId(selectedConversationId) }} />
                  <span className="mono chat__convid">{selectedConversationId}</span>
                </>
              ) : (
                <span className="chat__placeholder-title">No conversation selected</span>
              )}
            </div>
            <label className="toggle toggle--inline">
              <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
              <span>System events</span>
            </label>
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

            <div className="composer__row">
              <select className="composer__recipient" value={composerRecipient} onChange={(e) => setComposerRecipient(e.target.value)}>
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
                className="composer__input"
                placeholder="Message the fleet…  (Enter to send · Shift+Enter for newline)"
                value={composerText}
                rows={1}
                onChange={(e) => setComposerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
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
        <aside className="rail rail--right">
          <div className="tabs">
            {[
              ["approvals", `Approvals${overview.pendingApprovals ? ` (${overview.pendingApprovals})` : ""}`],
              ["agent", "Agent"],
              ["access", "Access"],
              ["deadletters", "Dead"],
              ["policies", "Policies"],
            ].map(([key, label]) => (
              <button key={key} className={`tab${rightTab === key ? " tab--active" : ""}`} onClick={() => setRightTab(key)}>
                {label}
              </button>
            ))}
          </div>

          <div className="rail__scroll">
            {rightTab === "approvals" && (
              <ApprovalsTab
                approvals={approvals}
                initialized={initialized.current.approvals}
                onApprove={(id) => handleApproval(id, "approve")}
                onReject={(id) => handleApproval(id, "reject")}
                onTrace={selectConversation}
              />
            )}

            {rightTab === "agent" && (
              <AgentTab
                agent={selectedAgent}
                detail={agentDetail}
                rateLimits={agentRateLimits}
                onControl={handleControl}
                onTrace={selectConversation}
              />
            )}

            {rightTab === "access" && (
              <AccessTab
                agents={agents}
                initialized={initialized.current.agents}
                trustPending={trustPending}
                onSetTrust={handleSetTrust}
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
                onTrace={selectConversation}
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

function ChatScroller({ items, hasConversation, now, settings, typingAgents, nameFor, animatedIds, typingNow, token }) {
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
        <EmptyState icon="✦" title="Start a conversation">
          Pick a conversation on the left, or message an agent below to open a new thread. Operator messages land in the agent’s inbox and appear here live.
        </EmptyState>
      </div>
    );
  }

  if (!items.length && !typingAgents.length) {
    return (
      <div className="chat__body chat__body--empty" ref={ref}>
        <EmptyState title="No messages yet">This conversation has no visible activity. Toggle system events to see heartbeats and delivery receipts, or send the first message.</EmptyState>
      </div>
    );
  }

  const animate = settings.typingAnimation && !prefersReducedMotion();

  return (
    <div className="chat__body" ref={ref} onScroll={handleScroll}>
      {items.map((item, idx) => {
        const prev = items[idx - 1];
        const grouped = prev && prev.kind === item.kind && prev.side === item.side && prev.senderId === item.senderId;
        const key = `${item.type}-${item.createdAt}-${idx}`;
        if (item.kind === "system") {
          return (
            <div className="sys-chip" key={key}>
              <span>{item.text}</span>
              <span className="sys-chip__time mono">{clockTime(item.createdAt)}</span>
            </div>
          );
        }
        const isOp = item.side === "operator";
        const label = isOp ? "Operator" : nameFor(item.senderId);
        const accent = isOp ? null : colorForAgent(item.senderId, settings);

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
        const startNew = animate && !isOp && id && isFresh && !done && !inFlight && !item.pending;
        if (startNew) typingNow.current.add(id);
        const shouldType = animate && !isOp && id && !done && (inFlight || startNew);

        const bubbleStyle = !isOp && accent ? { borderColor: `${accent}55` } : undefined;
        return (
          <div className={`bubble-row${isOp ? " bubble-row--op" : ""}${grouped ? " bubble-row--grouped" : ""}`} key={key}>
            {!isOp && !grouped ? <Avatar id={item.senderId} label={label} size={30} color={accent} /> : <span className="bubble-spacer" />}
            <div className="bubble-col">
              {!grouped ? (
                <div className="bubble-meta">
                  <span className="bubble-meta__name" style={!isOp && accent ? { color: accent } : undefined}>{label}</span>
                  <span className="bubble-meta__time mono">{clockTime(item.createdAt)}</span>
                </div>
              ) : null}
              <div className={`bubble${isOp ? " bubble--op" : ""}${item.pending ? " bubble--pending" : ""}${item.text ? "" : " bubble--media"}`} style={bubbleStyle}>
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
                      item.text
                    )}
                  </div>
                ) : null}
                {item.attachments?.length ? (
                  <AttachmentList token={token} attachments={item.attachments} onImageLoad={stickToBottom} />
                ) : null}
              </div>
            </div>
          </div>
        );
      })}

      {/* live typing indicators — one bubble per agent currently owed a reply */}
      {typingAgents.map((t) => {
        const accent = colorForAgent(t.agentId, settings);
        return (
          <div className="bubble-row bubble-row--typing" key={`typing-${t.agentId}`}>
            <Avatar id={t.agentId} label={t.label} size={30} color={accent} />
            <div className="bubble-col">
              <div className="bubble-meta">
                <span className="bubble-meta__name" style={{ color: accent }}>{t.label}</span>
                <span className="bubble-meta__time">typing…</span>
              </div>
              <div className="bubble bubble--typing" style={{ borderColor: `${accent}55` }}>
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

function AccessTab({ agents, initialized, trustPending, onSetTrust }) {
  if (!initialized) return <Skeleton count={3} height="64px" />;
  if (!agents.length) return <EmptyState title="No agents">Enroll an agent to grant it an operator-trusted channel.</EmptyState>;
  return (
    <div className="cards">
      <div className="access-caption">
        When ON, this agent recognizes the console operator as its verified principal. Risky actions still require approval.
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
