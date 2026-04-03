import crypto from "node:crypto";
import { config } from "./config";

export type AgentCredentials = {
  agentId: string;
  secret: string;
  relayBaseUrl: string;
  heartbeatIntervalSeconds: number;
  pollIntervalSeconds: number;
};

export type ActionDecision =
  | { decision: "allow" }
  | { decision: "deny" }
  | { decision: "pending_approval"; approval_id: string };

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

  get agentId() {
    return this.credentials.agentId;
  }

  get pollIntervalSeconds() {
    return this.credentials.pollIntervalSeconds ?? config.pollIntervalSeconds;
  }

  get heartbeatIntervalSeconds() {
    return this.credentials.heartbeatIntervalSeconds ?? config.heartbeatIntervalSeconds;
  }

  sendMessage(payload: {
    recipient: { kind: "agent" | "group" | "broadcast"; id?: string };
    message_type: "direct" | "broadcast" | "alert" | "handoff" | "claim" | "complete" | "heartbeat" | "control";
    priority?: "low" | "normal" | "high" | "urgent";
    ttl_seconds?: number;
    requires_approval?: boolean;
    body: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    conversation_id: string;
    correlation_id: string;
  }) {
    return this.request<{ message_id: string; status: string; queued_at: string }>("POST", "/v1/messages", payload);
  }

  getInbox(limit = 25) {
    return this.request<{
      messages: Array<Record<string, unknown>>;
      controls: Array<Record<string, unknown>>;
    }>("GET", `/v1/inbox?limit=${limit}`);
  }

  ackMessages(acks: Array<{ message_id: string; status: "received"; received_at: string }>) {
    return this.request<{ updated: number }>("POST", "/v1/acks", { acks });
  }

  heartbeat(payload: { status: "healthy" | "degraded" | "busy" | "idle"; active_conversation_ids?: string[]; metrics?: Record<string, unknown> }) {
    return this.request<{ ok: boolean; next_heartbeat_due_seconds: number }>("POST", "/v1/heartbeats", payload);
  }

  proposeAction(payload: {
    conversation_id: string;
    action_type: string;
    summary: string;
    risk_level: "low" | "medium" | "high" | "critical";
    payload: Record<string, unknown>;
  }) {
    return this.request<ActionDecision>("POST", "/v1/actions/propose", payload);
  }

  getApproval(approvalId: string) {
    return this.request<{
      id: string;
      status: string;
      action_type: string;
      risk_level: string;
      summary: string;
      requested_at: string;
      resolved_at: string | null;
    }>("GET", `/v1/actions/${approvalId}`);
  }

  actionResult(payload: { approval_id: string; result: "executed" | "cancelled" | "failed"; completed_at: string; output?: Record<string, unknown> }) {
    return this.request<{ ok: boolean }>("POST", "/v1/actions/result", payload);
  }
}
