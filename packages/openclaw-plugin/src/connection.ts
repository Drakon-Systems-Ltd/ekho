import os from "node:os";
import path from "node:path";
import { EkhoAgentClient } from "@drakon-systems/ekho-sdk";
import type { PluginApi } from "openclaw/plugin-sdk/tool-plugin";
import {
  enrollOrLoad,
  loadOrCreateIdentity,
  saveIdentity,
  identityPublicKey,
  takeEnrollOperatorKeys,
  type EkhoCredentials,
  type EkhoIdentity
} from "./credentials.js";
import { parseRequireSignedMode, syncPinnedOperatorKeys } from "./verification.js";
import { fromB64url, keyId as deriveKeyId } from "./identity.js";
import { startAutoReply } from "./autoreply.js";
import { appendDeadLetters } from "./dead-letter.js";

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
  // #5: "warn" (default) | "require" | "off". "require" wakes on a peer message
  // ONLY when it is signed and verifies; unsigned/unverifiable peers are
  // dead-lettered. EKHO_REQUIRE_SIGNED overrides per-process.
  requireSigned?: string;
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

// ---- Turn / model-call health (operator health board) --------------------
// The heartbeat status is hardcoded "healthy" — it only proves the CONNECTION
// is up. An agent whose MODEL is failing (bad auth, 404, quota) keeps
// heartbeating while every turn dies, so it reads green on the board while its
// brain is dead. That exact blind spot let a brain-dead agent look fine this
// week. We hook the host's model_call_ended and fold each outcome into a
// rolling window so the heartbeat can carry a truthful cognitive-health signal.

export interface ModelCallOutcome {
  t: number; // epoch ms
  ok: boolean; // outcome === "completed"
  category?: string; // errorCategory / failureKind when ok === false
}

const TURN_HEALTH_WINDOW_MS = 60 * 60_000; // 1h rolling window
const TURN_HEALTH_MAX = 200; // cap retained samples (memory bound)

let modelCalls: ModelCallOutcome[] = [];

/** Fold a finished model call into the rolling window (pruning old/oversized). */
export function noteModelCallEnded(
  outcome: string | undefined,
  category?: string,
  now: number = Date.now()
): void {
  const ok = outcome === "completed";
  modelCalls.push({ t: now, ok, category: ok ? undefined : (category || "error") });
  if (modelCalls.length > TURN_HEALTH_MAX) modelCalls = modelCalls.slice(-TURN_HEALTH_MAX);
  const cutoff = now - TURN_HEALTH_WINDOW_MS;
  let i = 0;
  while (i < modelCalls.length && modelCalls[i].t < cutoff) i++;
  if (i > 0) modelCalls = modelCalls.slice(i);
}

/**
 * Derive a truthful cognitive-health verdict from recent model-call outcomes.
 * Pure — the window is passed in — so the thresholds are unit-tested directly.
 *   down     : calls exist but NONE completed (brain failing every attempt — the
 *              Tars 404 case), or a run of >=3 consecutive failures after health.
 *   degraded : some errors mixed with successes in the window.
 *   ok       : recent success, no error tail.
 *   unknown  : no calls in the window — we never invent health.
 */
export function deriveTurnHealth(
  calls: ModelCallOutcome[],
  now: number = Date.now()
): {
  turn_health: "ok" | "degraded" | "down" | "unknown";
  errors_1h: number;
  calls_1h: number;
  last_error?: string;
  last_ok_at?: number;
} {
  const cutoff = now - TURN_HEALTH_WINDOW_MS;
  const win = calls.filter((c) => c.t >= cutoff);
  const calls_1h = win.length;
  if (calls_1h === 0) return { turn_health: "unknown", errors_1h: 0, calls_1h: 0 };
  const errors_1h = win.filter((c) => !c.ok).length;
  const hasSuccess = win.some((c) => c.ok);
  const lastOk = [...win].reverse().find((c) => c.ok);
  const lastErr = [...win].reverse().find((c) => !c.ok);
  let tail = 0;
  for (let i = win.length - 1; i >= 0 && !win[i].ok; i--) tail++;
  let verdict: "ok" | "degraded" | "down";
  if (!hasSuccess) verdict = "down"; // nothing completes = brain down
  else if (tail >= 3) verdict = "down"; // was healthy, now failing a run
  else if (errors_1h > 0) verdict = "degraded";
  else verdict = "ok";
  return {
    turn_health: verdict,
    errors_1h,
    calls_1h,
    last_error: verdict === "ok" ? undefined : lastErr?.category,
    last_ok_at: lastOk?.t
  };
}

/** Snapshot the current turn-health metrics for the heartbeat (string-valued, like model metrics). */
export function turnHealthMetrics(now: number = Date.now()): Record<string, string> {
  const h = deriveTurnHealth(modelCalls, now);
  if (h.turn_health === "unknown") return {};
  const m: Record<string, string> = {
    turn_health: h.turn_health,
    model_errors_1h: String(h.errors_1h),
    model_calls_1h: String(h.calls_1h)
  };
  if (h.last_error) m.last_error = h.last_error;
  if (h.last_ok_at) m.last_ok_at = new Date(h.last_ok_at).toISOString();
  return m;
}

/** Test seam: clear the rolling turn-health window. */
export function __resetTurnHealth(): void {
  modelCalls = [];
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
      // TOFU (#5): pin the operator keys the relay handed us at enrollment —
      // sent since the beginning, dropped on the floor until now. Only fires
      // for a never-pinned identity (see syncPinnedOperatorKeys); explicit
      // config pins above always win.
      const enrollKeys = takeEnrollOperatorKeys();
      if (enrollKeys && identity && syncPinnedOperatorKeys(identity, enrollKeys, credentials.fleetId || config.fleetId)) {
        saveIdentity(configDir, identity);
        log?.info?.(`[ekho] pinned ${Object.keys(identity.pinnedOperatorKeys).length} operator key(s) from enrollment (TOFU)`);
      }
    } catch (err) {
      log?.warn?.(`[ekho] identity bootstrap failed: ${String(err)}`);
    }

    if (!heartbeatTimer) {
      // Best-effort model/provider for the operator health board. Auto-detected
      // from the host (live model_call hook + config seed, see register), with
      // EKHO_REPORT_MODEL / EKHO_REPORT_PROVIDER as an explicit override/fallback.
      const reportMetrics = (): Record<string, string> => ({
        ...pickModelMetrics({
          envModel: process.env.EKHO_REPORT_MODEL,
          envProvider: process.env.EKHO_REPORT_PROVIDER,
          observedModel: observed.model,
          observedProvider: observed.provider,
          configModel: configured.model,
          configProvider: configured.provider
        }),
        // Truthful cognitive-health signal so a brain-dead-but-connected agent
        // (model 404/auth failing every turn) reads red, not green.
        ...turnHealthMetrics()
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
    // #5: how strictly peers must prove themselves before waking a turn.
    // Env beats config so an operator can flip one box without a config deploy.
    requireSigned: parseRequireSignedMode(process.env.EKHO_REQUIRE_SIGNED ?? config?.requireSigned),
    identity: identity ?? undefined,
    onIdentityChanged: (id) => {
      if (identityConfigDir) saveIdentity(identityConfigDir, id);
    },
    onVerificationReject: (rejects) => {
      if (!identityConfigDir) return;
      appendDeadLetters(
        identityConfigDir,
        rejects.map((r) => ({
          rejected_at: new Date().toISOString(),
          reason: r.verdict.reason,
          kind: r.verdict.kind,
          key_id: r.verdict.keyId,
          message: r.message
        }))
      );
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
