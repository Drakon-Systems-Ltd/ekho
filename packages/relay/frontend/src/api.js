const STORAGE_KEYS = {
  token: "ekho.operator.token",
  fleetId: "ekho.operator.fleetId",
  sessionEmail: "ekho.operator.email",
};

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function loadSession() {
  return {
    token: localStorage.getItem(STORAGE_KEYS.token) || "",
    fleetId: localStorage.getItem(STORAGE_KEYS.fleetId) || "",
    email: localStorage.getItem(STORAGE_KEYS.sessionEmail) || "",
  };
}

export function storeSession({ token, fleetId, email }) {
  localStorage.setItem(STORAGE_KEYS.token, token);
  localStorage.setItem(STORAGE_KEYS.fleetId, fleetId);
  localStorage.setItem(STORAGE_KEYS.sessionEmail, email);
}

export function clearSession() {
  Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
}

async function parseResponse(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.error?.fieldErrors
      ? JSON.stringify(data.error.fieldErrors)
      : data?.error || data?.message || `HTTP ${response.status}`;
    throw new ApiError(message, response.status);
  }

  return data;
}

export async function request(path, { token = "", method = "GET", body } = {}) {
  const headers = {};

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  return parseResponse(response);
}

export const login = (payload) => request("/v1/operator/login", { method: "POST", body: payload });
export const getOverview = (token) => request("/v1/operator/overview", { token });
export const getAgents = (token, params = {}) =>
  request(`/v1/operator/agents?${new URLSearchParams(params).toString()}`, { token });
export const getApprovals = (token, params = {}) =>
  request(`/v1/operator/approvals?${new URLSearchParams(params).toString()}`, { token });
export const getEvents = (token, params = {}) =>
  request(`/v1/operator/events?${new URLSearchParams(params).toString()}`, { token });
export const getAgentDetail = (token, agentId) =>
  request(`/v1/operator/agents/${encodeURIComponent(agentId)}`, { token });
export const getConversation = (token, conversationId) =>
  request(`/v1/operator/conversations/${encodeURIComponent(conversationId)}`, { token });
export const getConversationEvents = (token, conversationId, params = {}) =>
  request(`/v1/operator/conversations/${encodeURIComponent(conversationId)}?${new URLSearchParams(params).toString()}`, { token });
export const issueEnrollmentToken = (token) =>
  request("/v1/operator/enrollment-tokens", { token, method: "POST" });
export const sendOperatorMessage = (token, { recipientAgentId, roomId, text, conversationId, attachmentIds, mentions, replyTo, signature }) =>
  request("/v1/operator/messages", {
    token,
    method: "POST",
    body: {
      ...(roomId ? { room_id: roomId } : { recipient_agent_id: recipientAgentId }),
      text,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(attachmentIds?.length ? { attachment_ids: attachmentIds } : {}),
      ...(mentions?.length ? { mentions } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(signature
        ? {
            operator_sig: signature.operator_sig,
            key_id: signature.key_id,
            sig_canonical: signature.sig_canonical,
          }
        : {}),
    },
  });

// --- Verifiable operator identity (Security screen) ------------------------
export const listOperatorKeys = (token) => request("/v1/operator/keys", { token });
export const getAgentKeys = (token) => request("/v1/operator/agent-keys", { token });
export const registerOperatorKey = (token, { publicKey, label, endorsement }) =>
  request("/v1/operator/keys", {
    token,
    method: "POST",
    body: { public_key: publicKey, label, ...(endorsement ? { endorsement } : {}) },
  });
export const revokeOperatorKey = (token, keyId) =>
  request(`/v1/operator/keys/${encodeURIComponent(keyId)}`, { token, method: "DELETE" });
export const endorseAgentKey = (token, agentId, { keyId, endorsedByKeyId, signature }) =>
  request(`/v1/operator/agents/${encodeURIComponent(agentId)}/endorse-key`, {
    token,
    method: "POST",
    body: { key_id: keyId, endorsed_by_key_id: endorsedByKeyId, signature },
  });

export const getFleetHealth = (token) => request("/v1/operator/fleet-health", { token });
export const getAttention = (token) => request("/v1/operator/attention", { token });
export const getTopology = (token, { windowMinutes } = {}) =>
  request(`/v1/operator/topology${windowMinutes ? `?window_minutes=${windowMinutes}` : ""}`, { token });
export const getActivity = (token, { limit = 50, type } = {}) =>
  request(`/v1/operator/activity?${new URLSearchParams({ limit: String(limit), ...(type ? { type } : {}) }).toString()}`, { token });

// Rooms — named conversations with a chosen set of member agents.
export const getRooms = (token) => request("/v1/operator/rooms", { token });
export const createRoom = (token, { name, memberAgentIds }) =>
  request("/v1/operator/rooms", { token, method: "POST", body: { name, member_agent_ids: memberAgentIds } });
export const deleteRoom = (token, roomId) =>
  request(`/v1/operator/rooms/${encodeURIComponent(roomId)}`, { token, method: "DELETE" });
export const setRoomProjectMode = (token, roomId, { enabled, budget }) =>
  request(`/v1/operator/rooms/${encodeURIComponent(roomId)}/project-mode`, {
    token,
    method: "POST",
    body: budget ? { enabled, budget } : { enabled },
  });

// Resume a thread stalled on turn-budget exhaustion: the relay mints an operator
// nudge that re-opens every participant's latch and wakes them.
export const resumeConversation = (token, conversationId) =>
  request(`/v1/operator/conversations/${encodeURIComponent(conversationId)}/resume`, { token, method: "POST", body: {} });

// Feeds — operator-configured sources delivered to agents as non-waking context.
export const getFeeds = (token) => request("/v1/operator/feeds", { token });
export const createFeedSource = (token, { name, url, pollIntervalMinutes, subscriberAgentIds }) =>
  request("/v1/operator/feeds", {
    token,
    method: "POST",
    body: {
      name,
      url,
      ...(pollIntervalMinutes ? { poll_interval_minutes: pollIntervalMinutes } : {}),
      subscriber_agent_ids: subscriberAgentIds || [],
    },
  });
export const deleteFeedSource = (token, feedId) =>
  request(`/v1/operator/feeds/${encodeURIComponent(feedId)}`, { token, method: "DELETE" });
export const setFeedSubscribers = (token, feedId, agentIds) =>
  request(`/v1/operator/feeds/${encodeURIComponent(feedId)}/subscribers`, {
    token,
    method: "POST",
    body: { agent_ids: agentIds },
  });
export const pollFeedSource = (token, feedId) =>
  request(`/v1/operator/feeds/${encodeURIComponent(feedId)}/poll`, { token, method: "POST" });
export const getFeedItems = (token, feedId) =>
  request(`/v1/operator/feeds/${encodeURIComponent(feedId)}/items`, { token });

// Upload a single attachment (base64-in-JSON). Returns { id, filename, mime,
// size_bytes, created_at }. The relay cross-checks size_bytes against the decoded
// byte length, so the caller derives it from the actual bytes.
export const uploadOperatorAttachment = (token, { filename, mime, dataBase64, sizeBytes }) =>
  request("/v1/operator/attachments", {
    token,
    method: "POST",
    body: { filename, mime, size_bytes: sizeBytes, data_base64: dataBase64 },
  });

// The download route requires an Authorization header, so we can't point an
// <img src> at it directly. Fetch the bytes with the Bearer token and hand back
// an object URL; the caller MUST URL.revokeObjectURL it once done (on unmount).
export async function fetchAttachmentObjectUrl(token, id) {
  const res = await fetch(`/v1/operator/attachments/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
export const controlAgent = (token, agentId, action, body) =>
  request(`/v1/operator/agents/${encodeURIComponent(agentId)}/${action}`, {
    token,
    method: "POST",
    body,
  });
export const resolveApproval = (token, approvalId, decision) =>
  request(`/v1/operator/approvals/${encodeURIComponent(approvalId)}/${decision}`, {
    token,
    method: "POST",
  });
export const setAgentTrust = (token, agentId, trusted) =>
  request(`/v1/operator/agents/${encodeURIComponent(agentId)}/trust`, {
    token,
    method: "POST",
    body: { trusted },
  });
export const setPeerAutoreply = (token, agentId, autoreply, budget) =>
  request(`/v1/operator/agents/${encodeURIComponent(agentId)}/peer-autoreply`, {
    token,
    method: "POST",
    body: budget === undefined ? { autoreply } : { autoreply, budget },
  });
export const getPolicies = (token) =>
  request("/v1/operator/policies", { token });
export const createPolicy = (token, body) =>
  request("/v1/operator/policies", { token, method: "POST", body });
export const updatePolicy = (token, policyId, body) =>
  request(`/v1/operator/policies/${encodeURIComponent(policyId)}`, { token, method: "PUT", body });
export const deletePolicy = (token, policyId) =>
  request(`/v1/operator/policies/${encodeURIComponent(policyId)}`, { token, method: "DELETE" });
export const getDeadLetters = (token, params = {}) =>
  request(`/v1/operator/dead-letters?${new URLSearchParams(params).toString()}`, { token });
export const getDeadLetterDetail = (token, id) =>
  request(`/v1/operator/dead-letters/${encodeURIComponent(id)}`, { token });
export const getAgentRateLimits = (token, agentId) =>
  request(`/v1/operator/agents/${encodeURIComponent(agentId)}/rate-limits`, { token });
