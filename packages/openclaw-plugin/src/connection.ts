import os from "node:os";
import path from "node:path";
import { EkhoAgentClient } from "@drakon-systems/ekho-sdk";
import type { PluginApi } from "openclaw/plugin-sdk/tool-plugin";
import { enrollOrLoad, type EkhoCredentials } from "./credentials.js";
import { startAutoReply } from "./autoreply.js";

export interface EkhoPluginConfig {
  relayBaseUrl: string;
  fleetId?: string;
  enrollmentToken?: string;
  agentId?: string;
  agentSecret?: string;
  displayName?: string;
  heartbeatIntervalMs?: number;
  // Bounded agent-to-agent delegation (default off — opt-in per fleet).
  peerAutoreply?: boolean;
  peerTurnBudget?: number;
}

export interface EkhoConnection {
  client: EkhoAgentClient;
  credentials: EkhoCredentials;
}

type Logger = { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };

let connection: EkhoConnection | null = null;
let connecting: Promise<EkhoConnection> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let stopAutoReply: (() => void) | null = null;

/**
 * Enroll (or load saved credentials) and connect to the Ekho relay, starting a
 * background heartbeat so the agent shows healthy in the operator console and a
 * background auto-reply loop so the agent reacts to inbound fleet messages.
 * Idempotent and safe to call from every tool invocation — work happens once.
 *
 * `api` (when threaded from register) lets the auto-reply loop reach the host's
 * turn-trigger primitives (scheduleSessionTurn / runEmbeddedAgent). It is
 * optional: without it the loop still polls + caches the inbox but cannot wake
 * the agent, so the loop is only started when `api` is provided.
 */
export async function ensureConnected(config: EkhoPluginConfig, log?: Logger, api?: PluginApi): Promise<EkhoConnection> {
  if (connection) {
    maybeStartAutoReply(api, log, config);
    return connection;
  }
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
      // Best-effort metrics for the operator health board, from env so it's
      // generic (set EKHO_REPORT_MODEL / EKHO_REPORT_PROVIDER to surface them).
      const reportMetrics = (): Record<string, string> => {
        const m: Record<string, string> = {};
        const model = (process.env.EKHO_REPORT_MODEL ?? "").trim();
        const provider = (process.env.EKHO_REPORT_PROVIDER ?? "").trim();
        if (model) m.model = model;
        if (provider) m.provider = provider;
        return m;
      };
      const beat = () => { void client.heartbeat({ status: "healthy", metrics: reportMetrics() }).catch(() => {}); };
      beat();
      heartbeatTimer = setInterval(beat, config.heartbeatIntervalMs ?? 30_000);
      if (typeof heartbeatTimer === "object" && "unref" in heartbeatTimer) heartbeatTimer.unref?.();
    }

    connection = { client, credentials };
    log?.info?.(`[ekho] connected as ${credentials.agentId} -> ${credentials.relayBaseUrl}`);
    maybeStartAutoReply(api, log, config);
    return connection;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/**
 * Start the auto-reply loop exactly once, sharing the single connection's
 * client. Guarded like the heartbeat timer; needs both a live connection and an
 * `api` handle (for the turn-trigger primitives) before it does anything.
 */
function maybeStartAutoReply(api: PluginApi | undefined, log?: Logger, config?: EkhoPluginConfig) {
  if (stopAutoReply || !connection || !api) return;
  // The auto-reply loop wakes the agent by spawning `openclaw agent -m`, which
  // re-loads this plugin in a one-shot child. That child sets this env var so it
  // connects for the ekho_send tool but never starts its own loop (which would
  // double-process the inbox and could recurse).
  if (process.env.EKHO_AUTOREPLY_DISABLE === "1") {
    log?.info?.("[ekho-autoreply] disabled in this process (EKHO_AUTOREPLY_DISABLE)");
    return;
  }
  stopAutoReply = startAutoReply({
    client: connection.client,
    api,
    selfAgentId: connection.credentials.agentId,
    log,
    peerEnabled: config?.peerAutoreply ?? false,
    peerTurnBudget: config?.peerTurnBudget
  });
}

/**
 * Tear down the background timers (heartbeat + auto-reply loop) and reset the
 * singleton. Used by the register stop hook if the host provides one; safe to
 * call multiple times.
 */
export function shutdown() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (stopAutoReply) {
    stopAutoReply();
    stopAutoReply = null;
  }
}
