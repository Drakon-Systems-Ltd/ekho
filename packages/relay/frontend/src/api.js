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
export const sendOperatorMessage = (token, { recipientAgentId, roomId, text, conversationId, attachmentIds }) =>
  request("/v1/operator/messages", {
    token,
    method: "POST",
    body: {
      ...(roomId ? { room_id: roomId } : { recipient_agent_id: recipientAgentId }),
      text,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(attachmentIds?.length ? { attachment_ids: attachmentIds } : {}),
    },
  });

export const getFleetHealth = (token) => request("/v1/operator/fleet-health", { token });
export const getActivity = (token, { limit = 50, type } = {}) =>
  request(`/v1/operator/activity?${new URLSearchParams({ limit: String(limit), ...(type ? { type } : {}) }).toString()}`, { token });

// Rooms — named conversations with a chosen set of member agents.
export const getRooms = (token) => request("/v1/operator/rooms", { token });
export const createRoom = (token, { name, memberAgentIds }) =>
  request("/v1/operator/rooms", { token, method: "POST", body: { name, member_agent_ids: memberAgentIds } });
export const deleteRoom = (token, roomId) =>
  request(`/v1/operator/rooms/${encodeURIComponent(roomId)}`, { token, method: "DELETE" });

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
