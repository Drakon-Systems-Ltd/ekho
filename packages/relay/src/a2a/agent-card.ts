import type { A2AAgentCard } from "./types";

const PROTOCOL_VERSION = "0.3.0";
const RELAY_VERSION = "0.4.5";

interface AgentInfo {
  id: string;
  display_name: string | null;
  runtime: string | null;
  status: string;
}

export function buildFleetCard(opts: {
  baseUrl: string;
  fleetName: string;
  agents: AgentInfo[];
}): A2AAgentCard {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/a2a`;
  return {
    name: `Ekho Fleet: ${opts.fleetName}`,
    description:
      "Ekho relay fleet directory. Routes A2A messages to enrolled agents by agentId. Use per-agent cards at /agents/{agentId}/.well-known/agent-card.json for direct skill discovery.",
    url,
    version: RELAY_VERSION,
    provider: { organization: "Drakon Systems", url: "https://drakonsystems.com" },
    protocolVersion: PROTOCOL_VERSION,
    preferredTransport: "JSONRPC",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: opts.agents.map((a) => ({
      id: a.id,
      name: a.display_name ?? a.id,
      description: `Agent ${a.display_name ?? a.id} (${a.runtime ?? "unknown runtime"}, status: ${a.status}).`,
      tags: ["ekho-agent", a.runtime ?? "unknown", a.status],
    })),
    securitySchemes: {
      ekho_hmac: {
        type: "apiKey",
        in: "header",
        name: "x-ekho-signature",
        description:
          "HMAC-SHA256 signature over METHOD\\nPATH\\nTIMESTAMP\\nNONCE\\nSHA256(BODY). Requires x-ekho-agent-id, x-ekho-agent-secret, x-ekho-timestamp, x-ekho-nonce headers.",
      },
    },
    security: [{ ekho_hmac: [] }],
    supportsAuthenticatedExtendedCard: false,
  };
}

export function buildAgentCard(opts: {
  baseUrl: string;
  fleetName: string;
  agent: AgentInfo;
}): A2AAgentCard {
  const base = opts.baseUrl.replace(/\/$/, "");
  const url = `${base}/agents/${opts.agent.id}/a2a`;
  return {
    name: opts.agent.display_name ?? opts.agent.id,
    description: `Ekho agent ${opts.agent.display_name ?? opts.agent.id} in fleet ${opts.fleetName}. Runtime: ${opts.agent.runtime ?? "unknown"}. Messages are signed and store-and-forwarded with delivery guarantees.`,
    url,
    version: RELAY_VERSION,
    provider: { organization: "Drakon Systems", url: "https://drakonsystems.com" },
    protocolVersion: PROTOCOL_VERSION,
    preferredTransport: "JSONRPC",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: "message",
        name: "Send message",
        description: `Send a message to ${opts.agent.display_name ?? opts.agent.id} via the Ekho relay. Supports streaming responses and task lifecycle tracking.`,
        tags: ["messaging", "ekho-agent"],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["text/plain", "application/json"],
      },
    ],
    securitySchemes: {
      ekho_hmac: {
        type: "apiKey",
        in: "header",
        name: "x-ekho-signature",
        description:
          "HMAC-SHA256 signature over METHOD\\nPATH\\nTIMESTAMP\\nNONCE\\nSHA256(BODY). Requires x-ekho-agent-id, x-ekho-agent-secret, x-ekho-timestamp, x-ekho-nonce headers.",
      },
    },
    security: [{ ekho_hmac: [] }],
    supportsAuthenticatedExtendedCard: false,
  };
}
