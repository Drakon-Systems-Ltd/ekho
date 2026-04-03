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
