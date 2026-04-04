import { McpClient } from "./mcp-client";

export interface BeforeMessageContext {
  fleetId: string;
  senderAgentId: string;
  recipientId: string | null;
  messageType: string;
  priority: string;
  body: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface EkhoExtension {
  name: string;
  onBeforeMessage?(ctx: BeforeMessageContext): Promise<void>;
}

export interface ShieldCortexBridgeConfig {
  cortexBinaryPath: string;
  defenceProfile: "strict" | "balanced" | "permissive";
  enableMemoryExtraction: boolean;
  enableIronDome: boolean;
}

export function createShieldCortexExtension(config: ShieldCortexBridgeConfig): EkhoExtension {
  let client: McpClient | null = null;

  function getClient(): McpClient {
    if (!client) {
      client = new McpClient(config.cortexBinaryPath);
    }
    return client;
  }

  return {
    name: "shieldcortex-bridge",

    async onBeforeMessage(ctx: BeforeMessageContext): Promise<void> {
      const mcp = getClient();
      const bodyText = typeof ctx.body === "string" ? ctx.body : JSON.stringify(ctx.body);

      // 1. Injection scan
      try {
        const scanResult = await mcp.callTool("iron_dome_scan", { content: bodyText });
        const scanText = scanResult.content?.[0]?.text ?? "";

        let parsed: { clean?: boolean; riskLevel?: string; summary?: string } = {};
        try { parsed = JSON.parse(scanText); } catch {}

        if (parsed.riskLevel === "CRITICAL" || parsed.riskLevel === "HIGH") {
          if (config.defenceProfile === "strict") {
            throw new Error(`threat detected: ${parsed.summary ?? "high-risk content"}`);
          }
          // Balanced/permissive: log but allow
          console.warn(`[shieldcortex-bridge] threat in message from ${ctx.senderAgentId}: ${parsed.summary}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("threat detected:")) throw err;
        console.warn(`[shieldcortex-bridge] scan failed: ${err instanceof Error ? err.message : err}`);
      }

      // 2. Iron Dome action gate
      if (config.enableIronDome) {
        try {
          const gateResult = await mcp.callTool("iron_dome_check", {
            action: `send_message:${ctx.messageType}`,
            source: JSON.stringify({ type: "agent", identifier: ctx.senderAgentId })
          });
          const gateText = gateResult.content?.[0]?.text ?? "";

          let gateParsed: { decision?: string; reason?: string } = {};
          try { gateParsed = JSON.parse(gateText); } catch {}

          if (gateParsed.decision === "blocked") {
            throw new Error(`Iron Dome blocked: ${gateParsed.reason ?? "action not allowed"}`);
          }
          if (gateParsed.decision === "requires_approval") {
            throw new Error(`Iron Dome requires approval: ${gateParsed.reason ?? "action needs operator review"}`);
          }
        } catch (err) {
          if (err instanceof Error && (err.message.startsWith("Iron Dome blocked:") || err.message.startsWith("Iron Dome requires"))) throw err;
          console.warn(`[shieldcortex-bridge] action gate failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      // 3. Memory extraction (fire-and-forget)
      if (config.enableMemoryExtraction) {
        void (async () => {
          try {
            await mcp.callTool("remember", {
              title: `Agent ${ctx.senderAgentId} → ${ctx.recipientId ?? "broadcast"}: ${ctx.messageType}`,
              content: bodyText.slice(0, 2000),
              category: "pattern",
              tags: JSON.stringify(["ekho", "agent-communication", ctx.messageType]),
              source: JSON.stringify({ type: "agent", identifier: ctx.senderAgentId })
            });
          } catch {
            // Fire-and-forget — don't block message delivery
          }
        })();
      }
    }
  };
}

export { McpClient } from "./mcp-client";
