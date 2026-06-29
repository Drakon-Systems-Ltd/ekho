import crypto from "node:crypto";
import type {
  AgentCredentials,
  ActionDecision,
  AttachmentUploadInput,
  InboxResponse,
  MessageSnapshot,
  SendMessagePayload,
  HeartbeatPayload,
  ProposeActionPayload,
  ActionResultPayload
} from "./types";

export type FloorResult = {
  granted: boolean;
  holder_agent_id: string;
  expires_at: string;
  conversation_tail: MessageSnapshot[];
};

const DEFAULT_POLL_INTERVAL = 5;
const DEFAULT_HEARTBEAT_INTERVAL = 30;

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export class EkhoAgentClient {
  constructor(private readonly credentials: AgentCredentials) {}

  private signedHeaders(method: string, signaturePath: string, body: string) {
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const payload = `${method}\n${signaturePath}\n${timestamp}\n${nonce}\n${sha256(body)}`;
    const signature = crypto.createHmac("sha256", this.credentials.secret).update(payload).digest("hex");
    return {
      "content-type": "application/json",
      "x-ekho-agent-id": this.credentials.agentId,
      "x-ekho-agent-secret": this.credentials.secret,
      "x-ekho-timestamp": timestamp,
      "x-ekho-nonce": nonce,
      "x-ekho-signature": signature
    };
  }

  private async request<T>(method: string, routePath: string, payload?: unknown): Promise<T> {
    const body = payload ? JSON.stringify(payload) : "";
    const signaturePath = routePath.split("?")[0] ?? routePath;
    const response = await fetch(`${this.credentials.relayBaseUrl}${routePath}`, {
      method,
      headers: this.signedHeaders(method, signaturePath, body),
      body: method === "GET" ? undefined : body
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ekho request failed for ${routePath}: ${response.status} ${text}`);
    }

    return response.json() as Promise<T>;
  }

  get agentId() { return this.credentials.agentId; }
  get pollIntervalSeconds() { return this.credentials.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL; }
  get heartbeatIntervalSeconds() { return this.credentials.heartbeatIntervalSeconds ?? DEFAULT_HEARTBEAT_INTERVAL; }

  sendMessage(payload: SendMessagePayload) {
    return this.request<{ message_id: string; status: string; queued_at: string }>("POST", "/v1/messages", payload);
  }

  /**
   * Open a named topic room scoped to a set of fleet agents. Use this when a
   * collaboration has become a real topic worth its own discoverable, scoped
   * thread (instead of repeated 1:1 direct messages). This agent becomes the
   * creator and is auto-added as a member; `memberAgentIds` names the OTHER
   * agents to include (real, non-revoked agents in the same fleet). To post into
   * the room afterward, send with `recipient: { kind: "group", id: <room.id> }`.
   */
  createRoom(payload: { name: string; member_agent_ids?: string[] }) {
    return this.request<{ id: string; name: string; created_at: string; members: string[] }>(
      "POST", "/v1/rooms", { name: payload.name, member_agent_ids: payload.member_agent_ids ?? [] }
    );
  }

  getInbox(limit = 25) {
    return this.request<InboxResponse>("GET", `/v1/inbox?limit=${limit}`);
  }

  /** Register (or rotate) this agent's Ed25519 identity public key for
   *  agent-to-agent trust. Idempotent on the relay side. */
  registerIdentityKey(publicKey: string) {
    return this.request<{ key_id: string }>("POST", "/v1/identity-key", { public_key: publicKey });
  }

  ackMessages(acks: Array<{ message_id: string; status: "received"; received_at: string }>) {
    return this.request<{ updated: number }>("POST", "/v1/acks", { acks });
  }

  /** Acquire a conversation's floor so this agent — and not its peers — takes the
   *  next turn. Returns granted + the current holder + a fresh catch-up tail. */
  acquireFloor(conversationId: string, ttlSeconds?: number) {
    return this.request<FloorResult>(
      "POST", `/v1/conversations/${encodeURIComponent(conversationId)}/floor`,
      ttlSeconds === undefined ? {} : { ttl_seconds: ttlSeconds }
    );
  }

  /** Release a conversation's floor once this agent's turn is done. */
  releaseFloor(conversationId: string) {
    return this.request<{ released: boolean }>(
      "DELETE", `/v1/conversations/${encodeURIComponent(conversationId)}/floor`
    );
  }

  /** Raise an operator-visible notice that a conversation has stalled (e.g. the
   *  peer-turn budget is exhausted with real work withheld). Recorded as a
   *  `conversation.stalled` event; idempotent per (fleet, agent, conversation)
   *  until the next operator engagement, so it's safe to call best-effort. */
  raiseNotice(payload: { conversation_id: string; reason?: string; pending_count?: number; budget?: number }) {
    return this.request<{ ok: boolean; recorded: boolean }>("POST", "/v1/notices", payload);
  }

  heartbeat(payload: HeartbeatPayload) {
    return this.request<{ ok: boolean; next_heartbeat_due_seconds: number }>("POST", "/v1/heartbeats", payload);
  }

  proposeAction(payload: ProposeActionPayload) {
    return this.request<ActionDecision>("POST", "/v1/actions/propose", payload);
  }

  getApproval(approvalId: string) {
    return this.request<{
      id: string; status: string; action_type: string; risk_level: string;
      summary: string; requested_at: string; resolved_at: string | null;
    }>("GET", `/v1/actions/${approvalId}`);
  }

  actionResult(payload: ActionResultPayload) {
    return this.request<{ ok: boolean }>("POST", "/v1/actions/result", payload);
  }

  uploadAttachment(input: AttachmentUploadInput) {
    // size_bytes derived from the decoded byte length so the server cross-check passes.
    const size_bytes = Buffer.from(input.dataBase64, "base64").length;
    return this.request<{ id: string; filename: string; mime: string; size_bytes: number; created_at: string }>(
      "POST", "/v1/attachments",
      { filename: input.filename, mime: input.mime, size_bytes, data_base64: input.dataBase64 }
    );
  }

  async downloadAttachment(id: string): Promise<{ bytes: Buffer; filename: string; mime: string }> {
    const routePath = `/v1/attachments/${encodeURIComponent(id)}`;
    const signaturePath = routePath; // no query
    const response = await fetch(`${this.credentials.relayBaseUrl}${routePath}`, {
      method: "GET",
      headers: this.signedHeaders("GET", signaturePath, "")   // body "" → signs the same as other GETs
    });
    if (!response.ok) throw new Error(`Ekho download failed for ${routePath}: ${response.status} ${await response.text()}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const cd = response.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? id;
    return { bytes, filename, mime: response.headers.get("content-type") ?? "application/octet-stream" };
  }
}
