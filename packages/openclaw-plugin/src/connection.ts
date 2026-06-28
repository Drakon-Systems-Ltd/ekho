import os from "node:os";
import path from "node:path";
import { EkhoAgentClient } from "@drakon-systems/ekho-sdk";
import type { PluginApi } from "openclaw/plugin-sdk/tool-plugin";
import {
  enrollOrLoad,
  loadOrCreateIdentity,
  saveIdentity,
  identityPublicKey,
  type EkhoCredentials,
  type EkhoIdentity
} from "./credentials.js";
import { fromB64url, keyId as deriveKeyId } from "./identity.js";
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
  // Operator signing public key(s) to bootstrap-pin as the trust root (the
  // trusted out-of-band channel for agents that predate signing).
  // "<b64url>" or "<key_id>:<b64url>", comma-separated.
  operatorPubkey?: string;
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
let identity: EkhoIdentity | null = null;
let identityConfigDir = "";

/**
 * Register the agent's identity key with the relay and bootstrap-pin the operator
 * key(s) from config (the trusted out-of-band channel for agents that predate
 * signing). Best-effort: a relay blip must never break connecting.
 */
export async function registerAndBootstrapIdentity(
  client: EkhoAgentClient,
  opts: { operatorPubkey?: string; configDir: string; log?: Logger }
): Promise<EkhoIdentity> {
  const id = loadOrCreateIdentity(opts.configDir);
  try {
    await client.registerIdentityKey(identityPublicKey(id));
  } catch (err) {
    opts.log?.warn?.(`[ekho] identity-key registration failed: ${String(err)}`);
  }
  let changed = false;
  for (const raw of (opts.operatorPubkey ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const pub = entry.includes(":") ? entry.slice(entry.indexOf(":") + 1).trim() : entry;
    if (!pub) continue;
    let kid: string;
    try {
      kid = deriveKeyId(fromB64url(pub));
    } catch {
      continue; // skip a malformed key
    }
    if (id.pinnedOperatorKeys[kid] !== pub) {
      id.pinnedOperatorKeys[kid] = pub;
      changed = true;
    }
  }
  if (changed) saveIdentity(opts.configDir, id);
  return id;
}

// Model/provider surfaced to the operator health board on each heartbeat. Two
// auto-detected layers plus an explicit env override, resolved by precedence in
// pickModelMetrics: a live value observed from the host's model_call hook, and a
// seed read from the resolved OpenClaw config at register time (covers the first
// heartbeat, before any model call). model+provider are kept paired (see
// nextModelState) so a stale provider can never sit next to a different model.
let observed: { model: string; provider: string } = { model: "", provider: "" };
let configured: { model: string; provider: string } = { model: "", provider: "" };

/** The agent's loaded identity (for signing outbound messages); null pre-connect. */
export function getEkhoIdentity(): EkhoIdentity | null {
  return identity;
}

/** Split a "provider/model" ref into parts; tolerates bare ids, leading/extra slashes, and whitespace. */
export function splitModelRef(ref: string): { provider: string; model: string } {
  const s = (ref ?? "").trim().replace(/^\/+/, ""); // a leading slash means "no provider"
  if (!s) return { provider: "", model: "" };
  const i = s.indexOf("/");
  if (i > 0) return { provider: s.slice(0, i).trim(), model: s.slice(i + 1).trim() };
  return { provider: "", model: s };
}

/**
 * Fold a model observation into the running model/provider state. model and
 * provider move together: a ref carrying a model adopts THAT call's provider
 * (even an empty one — split from a "provider/model" ref or the explicit arg), so
 * a provider from an earlier, different model can't linger. A ref with no model
 * (empty/no-op event) keeps the last-known-good rather than blanking the board.
 * Pure, so the latching is unit-tested directly.
 */
export function nextModelState(
  prior: { model: string; provider: string },
  modelRef?: string,
  provider?: string
): { model: string; provider: string } {
  const parts = splitModelRef(modelRef ?? "");
  if (!parts.model) return prior;
  return { model: parts.model, provider: (provider ?? "").trim() || parts.provider };
}

/**
 * Resolve the {model, provider} metrics to report, by precedence:
 *   env override  >  live observed (model_call hook)  >  configured seed.
 * Each field resolves independently; whitespace-only counts as unset; an
 * all-empty result yields {} so the heartbeat carries no model keys (as before
 * any host set these). Pure — all inputs explicit — so it's unit-tested directly.
 */
export function pickModelMetrics(sources: {
  envModel?: string; envProvider?: string;
  observedModel?: string; observedProvider?: string;
  configModel?: string; configProvider?: string;
}): Record<string, string> {
  const pick = (...vals: Array<string | undefined>) => {
    for (const v of vals) {
      const t = (v ?? "").trim();
      if (t) return t;
    }
    return "";
  };
  const model = pick(sources.envModel, sources.observedModel, sources.configModel);
  const provider = pick(sources.envProvider, sources.observedProvider, sources.configProvider);
  const m: Record<string, string> = {};
  if (model) m.model = model;
  if (provider) m.provider = provider;
  return m;
}

/** Record the live model from a host model_call event (provider optional — may be embedded as "provider/model"). */
export function noteObservedModel(modelRef?: string, provider?: string): void {
  observed = nextModelState(observed, modelRef, provider);
}

/** Seed model/provider from the resolved OpenClaw config (a "provider/model" string). */
export function seedConfigModel(modelRef?: string, provider?: string): void {
  configured = nextModelState(configured, modelRef, provider);
}

/**
 * Best-effort: pull the agent's configured model out of an OpenClaw config object,
 * defensively. Only ever a SEED for the first heartbeat(s) — once the live
 * model_call hook fires, the observed value supersedes this (pickModelMetrics
 * ranks observed > config). `agents.list[0]` is a coarse last resort: in a
 * multi-agent host with no shared default it may pick a sibling agent's model for
 * that brief pre-first-call window; the live hook then corrects it.
 */
export function seedConfigModelFromOpenClawConfig(config: unknown): void {
  try {
    const c = config as Record<string, any> | undefined;
    if (!c || typeof c !== "object") return;
    const ref =
      c.agents?.defaults?.model?.primary ??
      c.agents?.list?.[0]?.model?.primary ??
      (typeof c.model === "string" ? c.model : c.model?.primary);
    if (typeof ref === "string" && ref.trim()) seedConfigModel(ref);
  } catch {
    /* host config shape varies by version — never let a probe throw */
  }
}

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

    // Register our identity key + bootstrap-pin the operator key (best-effort).
    identityConfigDir = configDir;
    try {
      identity = await registerAndBootstrapIdentity(client, {
        operatorPubkey: config.operatorPubkey,
        configDir,
        log
      });
    } catch (err) {
      log?.warn?.(`[ekho] identity bootstrap failed: ${String(err)}`);
    }

    if (!heartbeatTimer) {
      // Best-effort model/provider for the operator health board. Auto-detected
      // from the host (live model_call hook + config seed, see register), with
      // EKHO_REPORT_MODEL / EKHO_REPORT_PROVIDER as an explicit override/fallback.
      const reportMetrics = (): Record<string, string> =>
        pickModelMetrics({
          envModel: process.env.EKHO_REPORT_MODEL,
          envProvider: process.env.EKHO_REPORT_PROVIDER,
          observedModel: observed.model,
          observedProvider: observed.provider,
          configModel: configured.model,
          configProvider: configured.provider
        });
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
    peerEnabled: config?.peerAutoreply ?? true,
    peerTurnBudget: config?.peerTurnBudget,
    identity: identity ?? undefined,
    onIdentityChanged: (id) => {
      if (identityConfigDir) saveIdentity(identityConfigDir, id);
    }
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
