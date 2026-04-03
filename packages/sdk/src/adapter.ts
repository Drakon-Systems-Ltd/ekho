import { EkhoAgentClient } from "./client";
import type {
  AgentCredentials,
  InboxMessage,
  ControlMessage,
  SendMessagePayload,
  ProposeActionPayload,
  ActionResultPayload
} from "./types";

export type AdapterHooks = {
  onMessage?: (message: InboxMessage, adapter: EkhoAgentAdapter) => Promise<void>;
  beforeAction?: (action: ProposeActionPayload, adapter: EkhoAgentAdapter) => Promise<void>;
  onControl?: (control: ControlMessage, adapter: EkhoAgentAdapter) => Promise<void>;
  onApprovalPending?: (approvalId: string, adapter: EkhoAgentAdapter) => Promise<void>;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class EkhoAgentAdapter {
  private readonly client: EkhoAgentClient;
  private readonly hooks: AdapterHooks;
  private running = false;
  private paused = false;
  private activeConversationIds = new Set<string>();

  constructor(credentials: AgentCredentials, hooks: AdapterHooks = {}) {
    this.client = new EkhoAgentClient(credentials);
    this.hooks = hooks;
  }

  get agentId() { return this.client.agentId; }

  async start() {
    if (this.running) return;
    this.running = true;
    void this.heartbeatLoop();
    void this.inboxLoop();
  }

  stop() { this.running = false; }

  async send(payload: SendMessagePayload) {
    return this.client.sendMessage(payload);
  }

  async proposeAction(action: ProposeActionPayload) {
    if (this.hooks.beforeAction) await this.hooks.beforeAction(action, this);
    if (this.paused) throw new Error("agent is paused by control plane");

    const decision = await this.client.proposeAction(action);
    if (decision.decision === "allow") return decision;
    if (decision.decision === "deny") throw new Error("action denied by Ekho policy");

    if (this.hooks.onApprovalPending) await this.hooks.onApprovalPending(decision.approval_id, this);

    while (this.running) {
      const approval = await this.client.getApproval(decision.approval_id);
      if (approval.status === "approved" || approval.status === "executed") return decision;
      if (approval.status === "rejected" || approval.status === "cancelled" || approval.status === "expired") {
        throw new Error(`action ${approval.status} by operator`);
      }
      await sleep(1500);
    }
    throw new Error("adapter stopped while waiting for approval");
  }

  async reportActionResult(payload: ActionResultPayload) {
    return this.client.actionResult(payload);
  }

  private async heartbeatLoop() {
    while (this.running) {
      try {
        await this.client.heartbeat({
          status: this.paused ? "degraded" : "healthy",
          active_conversation_ids: [...this.activeConversationIds],
          metrics: { paused: this.paused }
        });
      } catch (error) {
        console.error("[ekho-adapter] heartbeat failed", error);
      }
      await sleep(this.client.heartbeatIntervalSeconds * 1000);
    }
  }

  private async inboxLoop() {
    while (this.running) {
      try {
        const inbox = await this.client.getInbox();
        for (const control of inbox.controls as ControlMessage[]) await this.handleControl(control);
        for (const raw of inbox.messages as InboxMessage[]) {
          this.activeConversationIds.add(raw.conversation_id);
          if (this.hooks.onMessage) await this.hooks.onMessage(raw, this);
          await this.client.ackMessages([
            { message_id: raw.message_id, status: "received", received_at: new Date().toISOString() }
          ]);
        }
      } catch (error) {
        console.error("[ekho-adapter] inbox loop failed", error);
      }
      await sleep(this.client.pollIntervalSeconds * 1000);
    }
  }

  private async handleControl(control: ControlMessage) {
    if (control.action === "pause" || control.action === "quarantine") this.paused = true;
    if (control.action === "resume") this.paused = false;
    if (this.hooks.onControl) await this.hooks.onControl(control, this);
  }
}
