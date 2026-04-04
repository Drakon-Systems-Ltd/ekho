import path from "node:path";
import { enrollOrLoad, type EkhoCredentials } from "./credentials";
import { InboxPoller } from "./poller";

interface PluginConfig {
  relayBaseUrl?: string;
  fleetId?: string;
  enrollmentToken?: string;
  agentId?: string;
  agentSecret?: string;
  pollIntervalMs?: number;
  forwardOutbound?: boolean;
}

interface PluginApi {
  id: string;
  pluginConfig?: PluginConfig;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  registerHook: (name: string | string[], handler: (...args: unknown[]) => unknown, opts?: { name?: string; description?: string }) => void;
  registerCommand: (def: { name: string; description: string; handler: () => Promise<{ text: string }> }) => void;
  resolvePath?: (input: string) => string;
}

let poller: InboxPoller | null = null;
let credentials: EkhoCredentials | null = null;
let connected = false;

async function ensureConnected(api: PluginApi): Promise<boolean> {
  if (connected && poller) return true;

  const config = api.pluginConfig ?? {};
  const relayBaseUrl = config.relayBaseUrl ?? "http://127.0.0.1:4000";
  const configDir = api.resolvePath ? api.resolvePath(".") : path.join(process.env.HOME ?? "~", ".openclaw", "extensions", "ekho-adapter");

  try {
    credentials = await enrollOrLoad({
      configDir,
      relayBaseUrl,
      fleetId: config.fleetId,
      enrollmentToken: config.enrollmentToken,
      agentId: config.agentId,
      agentSecret: config.agentSecret,
      displayName: `openclaw-${process.env.HOSTNAME ?? "agent"}`
    });

    poller = new InboxPoller(credentials, config.pollIntervalMs ?? 5000, {
      onMessage(msg) {
        api.logger.info(`[ekho] message from ${msg.sender_agent_id}: ${msg.message_type}`, msg.body);
      },
      onControl(ctrl) {
        api.logger.warn(`[ekho] control: ${ctrl.action} — ${ctrl.reason}`);
      },
      onError(err) {
        api.logger.error(`[ekho] poll error: ${err.message}`);
      }
    });

    poller.start();
    connected = true;
    api.logger.info(`[ekho] connected as ${credentials.agentId}`);
    return true;
  } catch (err) {
    api.logger.error(`[ekho] connection failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

export default {
  id: "ekho-adapter",
  name: "Ekho Relay Adapter",
  version: "0.1.0",
  description: "Connect this OpenClaw agent to an Ekho relay for inter-agent messaging",

  register(api: PluginApi) {
    api.logger.info("[ekho] registering Ekho adapter plugin");

    // Connect on session start
    api.registerHook("session_start", () => {
      void ensureConnected(api);
    }, { name: "ekho-connect", description: "Connect to Ekho relay" });

    // Clean up on session end
    api.registerHook("session_end", () => {
      if (poller) {
        poller.stop();
        connected = false;
        api.logger.info("[ekho] disconnected");
      }
    }, { name: "ekho-disconnect", description: "Disconnect from Ekho relay" });

    // Optionally forward outbound messages
    const config = api.pluginConfig ?? {};
    if (config.forwardOutbound) {
      api.registerHook("message_sending", (event: unknown) => {
        if (!poller || !connected) return;
        const evt = event as { content?: string; role?: string };
        if (evt.role === "assistant" && evt.content) {
          void poller.sendMessage(
            "broadcast",
            evt.content.slice(0, 500),
            `openclaw-session-${Date.now()}`
          ).catch(() => {});
        }
      }, { name: "ekho-forward", description: "Forward outbound messages to Ekho" });
    }

    // Status command
    api.registerCommand({
      name: "ekho-status",
      description: "Show Ekho relay connection status",
      async handler() {
        if (!connected || !credentials) {
          return { text: "Ekho: disconnected\n  Run /ekho-connect to connect." };
        }
        return {
          text: [
            `Ekho: connected`,
            `  Agent:  ${credentials.agentId}`,
            `  Relay:  ${credentials.relayBaseUrl}`,
            `  Fleet:  ${credentials.fleetId}`,
            `  Polling: every ${(api.pluginConfig?.pollIntervalMs ?? 5000) / 1000}s`
          ].join("\n")
        };
      }
    });

    // Manual send command
    api.registerCommand({
      name: "ekho-send",
      description: "Send a message to another agent via Ekho (usage: /ekho-send <agent_id> <message>)",
      async handler() {
        return { text: "Usage: /ekho-send <agent_id> <message>\n(Command argument parsing requires OpenClaw command args support)" };
      }
    });

    // Auto-connect on load if credentials exist
    void ensureConnected(api);
  }
};

export { InboxPoller } from "./poller";
export { enrollOrLoad, loadCredentials, saveCredentials } from "./credentials";
export type { EkhoCredentials } from "./credentials";
