import os from "node:os";
import path from "node:path";
import { EkhoAgentClient } from "@drakon-systems/ekho-sdk";
import { enrollOrLoad, type EkhoCredentials } from "./credentials.js";

export interface EkhoPluginConfig {
  relayBaseUrl: string;
  fleetId?: string;
  enrollmentToken?: string;
  agentId?: string;
  agentSecret?: string;
  displayName?: string;
  heartbeatIntervalMs?: number;
}

export interface EkhoConnection {
  client: EkhoAgentClient;
  credentials: EkhoCredentials;
}

type Logger = { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };

let connection: EkhoConnection | null = null;
let connecting: Promise<EkhoConnection> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Enroll (or load saved credentials) and connect to the Ekho relay, starting a
 * background heartbeat so the agent shows healthy in the operator console.
 * Idempotent and safe to call from every tool invocation — work happens once.
 */
export async function ensureConnected(config: EkhoPluginConfig, log?: Logger): Promise<EkhoConnection> {
  if (connection) return connection;
  if (connecting) return connecting;

  connecting = (async () => {
    const configDir = path.join(os.homedir(), ".openclaw", "extensions", "ekho-adapter");
    const credentials = await enrollOrLoad({
      configDir,
      relayBaseUrl: config.relayBaseUrl,
      fleetId: config.fleetId,
      enrollmentToken: config.enrollmentToken,
      agentId: config.agentId,
      agentSecret: config.agentSecret,
      displayName: config.displayName ?? `openclaw-${os.hostname()}`
    });

    const client = new EkhoAgentClient({
      agentId: credentials.agentId,
      secret: credentials.secret,
      relayBaseUrl: credentials.relayBaseUrl
    });

    if (!heartbeatTimer) {
      const beat = () => { void client.heartbeat({ status: "healthy" }).catch(() => {}); };
      beat();
      heartbeatTimer = setInterval(beat, config.heartbeatIntervalMs ?? 30_000);
      if (typeof heartbeatTimer === "object" && "unref" in heartbeatTimer) heartbeatTimer.unref?.();
    }

    connection = { client, credentials };
    log?.info?.(`[ekho] connected as ${credentials.agentId} -> ${credentials.relayBaseUrl}`);
    return connection;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}
