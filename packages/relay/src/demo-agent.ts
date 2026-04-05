import { EkhoAgentAdapter, type InboxMessage, type ControlMessage } from "@ekho/sdk";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

const adapter = new EkhoAgentAdapter(
  {
    agentId: requireEnv("EKHO_AGENT_ID"),
    secret: requireEnv("EKHO_AGENT_SECRET"),
    relayBaseUrl: process.env.EKHO_AGENT_RELAY_URL ?? "http://127.0.0.1:4000",
    heartbeatIntervalSeconds: Number(process.env.EKHO_AGENT_HEARTBEAT_INTERVAL ?? "30"),
    pollIntervalSeconds: Number(process.env.EKHO_AGENT_POLL_INTERVAL ?? "5")
  },
  {
    async onMessage(message: InboxMessage, currentAdapter: EkhoAgentAdapter) {
      console.log(`[demo-agent] received ${message.message_type} from ${message.sender_agent_id}:`, message.body);

      if (message.message_type === "handoff") {
        const decision = await currentAdapter.proposeAction({
          conversation_id: message.conversation_id,
          action_type: "demo_reply",
          summary: "Reply to handoff with confirmation",
          risk_level: "low",
          payload: { reply_to: message.message_id }
        });

        if (decision.decision === "allow") {
          await currentAdapter.send({
            recipient: { kind: "agent", id: message.sender_agent_id },
            message_type: "complete",
            priority: "normal",
            ttl_seconds: 900,
            body: {
              text: `Ack from ${currentAdapter.agentId}`,
              reply_to: message.message_id
            },
            metadata: { adapter: "demo" },
            conversation_id: message.conversation_id,
            correlation_id: message.correlation_id
          });
        }
      }
    },
    async onControl(control: ControlMessage) {
      console.log(`[demo-agent] control ${control.action}: ${control.reason}`);
    },
    async onApprovalPending(approvalId: string) {
      console.log(`[demo-agent] waiting for approval ${approvalId}`);
    }
  }
);

adapter.start().catch((error: Error) => {
  console.error(error);
  process.exit(1);
});

process.on("SIGINT", () => {
  adapter.stop();
  process.exit(0);
});
