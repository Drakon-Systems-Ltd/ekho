import { EkhoAgentClient } from "@ekho/sdk";
import type { EkhoCredentials } from "./credentials";

export interface PollerCallbacks {
  onMessage: (message: Record<string, unknown>) => void;
  onControl: (control: Record<string, unknown>) => void;
  onError: (error: Error) => void;
}

export class InboxPoller {
  private client: EkhoAgentClient;
  private intervalMs: number;
  private callbacks: PollerCallbacks;
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(credentials: EkhoCredentials, intervalMs: number, callbacks: PollerCallbacks) {
    this.client = new EkhoAgentClient({
      agentId: credentials.agentId,
      secret: credentials.secret,
      relayBaseUrl: credentials.relayBaseUrl
    });
    this.intervalMs = intervalMs;
    this.callbacks = callbacks;
  }

  start() {
    if (this.handle) return;

    // Send initial heartbeat
    this.client.heartbeat({ status: "healthy" }).catch(() => {});

    this.handle = setInterval(async () => {
      try {
        const inbox = await this.client.getInbox();

        for (const control of inbox.controls as Array<Record<string, unknown>>) {
          this.callbacks.onControl(control);
        }

        if (inbox.messages.length > 0) {
          const acks: Array<{ message_id: string; status: "received"; received_at: string }> = [];

          for (const msg of inbox.messages as Array<Record<string, unknown>>) {
            this.callbacks.onMessage(msg);
            acks.push({
              message_id: String(msg.message_id),
              status: "received",
              received_at: new Date().toISOString()
            });
          }

          await this.client.ackMessages(acks);
        }
      } catch (err) {
        this.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }, this.intervalMs);
  }

  stop() {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  async sendMessage(recipientAgentId: string, text: string, conversationId: string) {
    return this.client.sendMessage({
      recipient: { kind: "agent", id: recipientAgentId },
      message_type: "direct",
      body: { text },
      conversation_id: conversationId,
      correlation_id: `openclaw-${Date.now()}`
    });
  }

  async heartbeat(status: "healthy" | "degraded" = "healthy") {
    return this.client.heartbeat({ status });
  }

  get agentId() { return this.client.agentId; }
}
