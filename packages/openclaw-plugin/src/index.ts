import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { ensureConnected, type EkhoPluginConfig } from "./connection.js";

/**
 * Ekho relay adapter for OpenClaw.
 *
 * Gives the agent two tools to coordinate with the rest of an Ekho fleet:
 *   - ekho_send:  message another agent (delegate, ask, coordinate)
 *   - ekho_inbox: read pending messages from other agents
 *
 * On startup (and again lazily on first tool use) it enrolls (or loads saved
 * credentials) and starts a background heartbeat so the agent appears healthy
 * in the operator console without having to call a tool first. All identity
 * (relay URL, fleet, token) comes from per-agent config — nothing is hardcoded.
 */
const plugin = defineToolPlugin({
  id: "ekho-adapter",
  name: "Ekho Relay Adapter",
  description: "Connect this agent to an Ekho relay to message and coordinate with other agents in the fleet.",
  activation: { onStartup: true },
  configSchema: Type.Object({
    relayBaseUrl: Type.String({ description: "Ekho relay base URL, e.g. https://relay.example.ts.net" }),
    fleetId: Type.Optional(Type.String({ description: "Fleet ID to enroll into (with enrollmentToken on first run)" })),
    enrollmentToken: Type.Optional(Type.String({ description: "One-time operator enrollment token (first run only)" })),
    agentId: Type.Optional(Type.String({ description: "Pre-provisioned agent id (skips enrollment)" })),
    agentSecret: Type.Optional(Type.String({ description: "Pre-provisioned agent secret (skips enrollment)" })),
    displayName: Type.Optional(Type.String({ description: "Display name shown in the operator console" })),
    heartbeatIntervalMs: Type.Optional(Type.Number({ description: "Heartbeat interval in ms (default 30000)" }))
  }),
  tools: (tool) => [
    tool({
      name: "ekho_send",
      description:
        "Send a message to another agent in your fleet via the Ekho relay. Use this to delegate a task, ask a question, hand off work, or coordinate. Set recipient_agent_id to 'broadcast' to reach the whole fleet.",
      parameters: Type.Object({
        recipient_agent_id: Type.String({ description: "Ekho agent_id of the recipient, or 'broadcast' for the whole fleet." }),
        message: Type.String({ description: "The message text to send." }),
        conversation_id: Type.Optional(Type.String({ description: "Existing conversation id to thread under (optional)." }))
      }),
      execute: async ({ recipient_agent_id, message, conversation_id }, config: EkhoPluginConfig) => {
        const { client } = await ensureConnected(config);
        const conversationId = conversation_id ?? `oc-${Date.now()}`;
        const stamp = `oc-${Date.now()}`;
        const result = await client.sendMessage({
          recipient: recipient_agent_id === "broadcast" ? { kind: "broadcast" } : { kind: "agent", id: recipient_agent_id },
          message_type: "direct",
          body: { text: message },
          conversation_id: conversationId,
          correlation_id: stamp
        });
        return { sent: true, message_id: result.message_id, conversation_id: conversationId };
      }
    }),
    tool({
      name: "ekho_inbox",
      description:
        "Read and acknowledge messages other agents have sent you via the Ekho relay. Call this to check for delegated tasks, replies, or coordination requests.",
      parameters: Type.Object({}),
      execute: async (_params, config: EkhoPluginConfig) => {
        const { client } = await ensureConnected(config);
        const inbox = await client.getInbox();
        const messages = inbox.messages as Array<Record<string, unknown>>;
        if (messages.length > 0) {
          await client.ackMessages(
            messages.map((m) => ({
              message_id: String(m.message_id),
              status: "received" as const,
              received_at: new Date().toISOString()
            }))
          );
        }
        return {
          count: messages.length,
          messages: messages.map((m) => ({
            from: m.sender_agent_id,
            type: m.message_type,
            body: m.body,
            conversation_id: m.conversation_id,
            sent_at: m.created_at
          })),
          controls: inbox.controls
        };
      }
    })
  ]
});

// Extend the tool plugin's register() so the agent connects on gateway startup —
// enroll/load credentials and begin heartbeating immediately, so it shows healthy
// in the operator console without waiting for the first tool call. Failure here is
// non-fatal: the tools still connect lazily on first use.
const registerTools = plugin.register;
plugin.register = (api) => {
  registerTools(api);
  const config = api.pluginConfig as EkhoPluginConfig | undefined;
  if (config?.relayBaseUrl) {
    void ensureConnected(config, api.logger).catch((err) => {
      api.logger?.warn?.(`[ekho-adapter] startup connect failed: ${String(err)}`);
    });
  }
};

export default plugin;
