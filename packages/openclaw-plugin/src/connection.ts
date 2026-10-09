import { createHash } from "node:crypto";
import os from "node:os";
import { EkhoAgentClient } from "@drakon-systems/ekho-sdk";
import type { PluginApi } from "openclaw/plugin-sdk/tool-plugin";
import {
  enrollOrLoad,
  loadOrCreateIdentity,
  storedCredentialsState,
  saveIdentity,
  IdentityUnavailableError,
  ALLOW_NEW_IDENTITY_ENV,
  identityPublicKey,
  takeEnrollOperatorKeys,
  EnrollmentFailedError,
  type EkhoCredentials,
  type EkhoIdentity,
  type EnrollOperatorKey
} from "./credentials.js";
import { parseRequireSignedMode, syncPinnedOperatorKeys } from "./verification.js";
import { fromB64url, keyId as deriveKeyId } from "./identity.js";
import { inboxCacheContext, startAutoReply } from "./autoreply.js";
import { appendDeadLetters } from "./dead-letter.js";
import { LEGACY_EKHO_DIR, migrateLegacyEkhoState, resolveEkhoStateDir } from "./state-dir.js";
import {
  claimAgentRuntime,
  depositReloadHandoff,
  nextRuntimeGeneration,
  noteReloadServed,
  putEnrolOperatorKeys,
  releaseAgentRuntime,
  reloadServedBy,
  runEnrolmentExclusive,
  takeEnrolOperatorKeys,
  takeReloadHandoff
} from "./runtime-registry.js";

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
  // Optional local turn limit: positive = cap when the relay sets none; 0/absent = no limit.
  peerTurnBudget?: number;
  // Operator signing public key(s) to bootstrap-pin as the trust root (the
  // trusted out-of-band channel for agents that predate signing).
  // "<b64url>" or "<key_id>:<b64url>", comma-separated.
  operatorPubkey?: string;
  /**
   * Let an already-enrolled agent mint a brand-new identity key when its
   * identity file is absent. Off by default; EKHO_ALLOW_NEW_IDENTITY=1 is the
   * env equivalent. See credentials.ts IdentityUnavailableError.
   */
  allowNewIdentity?: boolean;
  // #5: "warn" (default) | "require" | "off". "require" wakes on a peer message
  // ONLY when it is signed and verifies; unsigned/unverifiable peers are
  // dead-lettered. EKHO_REQUIRE_SIGNED overrides per-process.
  requireSigned?: string;
  /** Overrides where credentials/identity live (#98). Default: see resolveEkhoStateDir. */
  stateDir?: string;
}

export interface EkhoConnection {
  client: EkhoAgentClient;
  credentials: EkhoCredentials;
}

export function connectedInboxContext(current: EkhoConnection): string {
  return inboxCacheContext(current.credentials.relayBaseUrl, current.credentials.agentId, current.credentials.fleetId, identity ?? undefined);
}

type Logger = { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };

let connection: EkhoConnection | null = null;
let connecting: Promise<EkhoConnection> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let stopAutoReply: (() => Promise<void>) | null = null;
// The last stop's drain (see shutdown), handed to every later shutdown call:
// the host may fire more than one unload signal and await each.
let stopDrain: Promise<void> = Promise.resolve();
let identity: EkhoIdentity | null = null;
let identityConfigDir = "";

// This module copy's place in the process-wide producer order (see
// runtime-registry.ts). A host reload evaluates a fresh copy, which takes a
// higher number and stops this one's timers when it connects.
const generation = nextRuntimeGeneration();
// Set once this copy has been stopped (host unload, or superseded by a newer
// copy). A retired copy still hands its client to a straggling tool call, but
// never starts a heartbeat or an auto-reply loop again: restarting would make
// it a second producer next to the generation that replaced it.
let retired = false;
// The agent this copy holds in the registry, for release on shutdown.
let claimedAgentId: string | null = null;

// After the relay refuses an enrolment token (400: spent), how long to wait
// before looking once more for credentials someone saved meanwhile.
export const ENROL_RECHECK_MS = 2_000;

/**
 * Register the agent's identity key with the relay and bootstrap-pin the operator
 * key(s) from config (the trusted out-of-band channel for agents that predate
 * signing). Best-effort: a relay blip must never break connecting.
 */
/**
 * May this process mint a brand-new identity key if none is on disk? Yes for a
 * fresh enrolment (no agentId/secret in config yet). For an enrolled agent only
 * with the operator's explicit say-so: the env flag or `allowNewIdentity` in
 * the plugin config. Pure, so the rule itself is tested, not just the loader.
 */
export function shouldAllowNewIdentity(
  config: { agentId?: string; agentSecret?: string; allowNewIdentity?: boolean },
  env: NodeJS.ProcessEnv,
  state: {
    /**
     * Whether a credentials file already existed BEFORE this connect. A
     * token-enrolled agent carries no agentId/secret in config; its enrolment
     * lives only in that file, and it is just as enrolled (review, Tars, 4 Oct).
     */
    hasStoredCredentials: boolean;
  }
): boolean {
  const enrolled = state.hasStoredCredentials || Boolean(config.agentId && config.agentSecret);
  return !enrolled || env[ALLOW_NEW_IDENTITY_ENV] === "1" || config.allowNewIdentity === true;
}

export async function registerAndBootstrapIdentity(
  client: EkhoAgentClient,
  opts: { operatorPubkey?: string; configDir: string; log?: Logger; allowCreate?: boolean }
): Promise<EkhoIdentity> {
  // Throws IdentityUnavailableError rather than minting over a lost or
  // unreadable file — see credentials.ts. Nothing is registered in that case.
  const id = loadOrCreateIdentity(opts.configDir, { allowCreate: opts.allowCreate });
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
    // #14: the seed is a bootstrap hint, never an override. Without this check
    // the poll's revocation drop and the config re-pin fought on every wake and
    // the config won, so a compromised key stayed trusted forever. Warn loudly:
    // the operator's config is stale and only they can fix it.
    const revokedAt = id.revokedOperatorKeys?.[kid];
    if (revokedAt) {
      opts.log?.warn?.(
        `[ekho] ignoring configured operatorPubkey ${kid}: the relay reported it REVOKED at ${revokedAt}. ` +
          `Remove it from the ekho plugin config (operatorPubkey) — a revoked key is never re-pinned.`
      );
      if (id.pinnedOperatorKeys[kid]) {
        delete id.pinnedOperatorKeys[kid];
        changed = true;
      }
      continue;
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

/**
 * Snapshot the current turn-health metrics for the heartbeat (string-valued,
 * like model metrics). An empty window is reported as "unknown", not omitted:
 * an absent field reads the same as a plugin too old to send one, so a
 * model_call hook that never fires would otherwise be invisible on the board.
 * The relay's health classification treats "unknown" exactly like absent
 * (fleet-health.ts), and the console shows both as the same muted badge.
 */
export function turnHealthMetrics(now: number = Date.now()): Record<string, string> {
  const h = deriveTurnHealth(modelCalls, now);
  if (h.turn_health === "unknown") return { turn_health: "unknown", model_calls_1h: "0" };
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
    maybeStartHeartbeat(log, config);
    maybeStartAutoReply(api, log, config);
    return connection;
  }
  if (connecting) return connecting;

  connecting = (async () => {
    // Not the install dir: `openclaw plugins update` replaces that wholesale,
    // trust files and all (#98).
    const configDir = resolveEkhoStateDir(config);
    // Before anything reads configDir: carry pre-#98 state over from the old
    // location. A credentials failure stops the connect, as an unusable file
    // in configDir would. An identity failure is held and surfaced where the
    // identity is loaded, so the agent runs unsigned exactly as it would for
    // an unusable file here — it must not reach the loader as "absent", which
    // on an apparently fresh box would mint.
    let migrationIdentityError: IdentityUnavailableError | undefined;
    try {
      migrateLegacyEkhoState(configDir, LEGACY_EKHO_DIR, log);
    } catch (err) {
      if (!(err instanceof IdentityUnavailableError)) throw err;
      migrationIdentityError = err;
    }
    // Read BEFORE enrollOrLoad: a fresh enrolment writes this file, and the
    // identity rule below must see the state as it was when we arrived.
    const hasStoredCredentials = storedCredentialsState(configDir).state !== "absent";
    const retiredAtStart = retired;
    const enrolKey = enrolmentKey(config);
    const credentials = await enrollOrLoadOnce(
      {
        configDir,
        relayBaseUrl: config.relayBaseUrl,
        fleetId: config.fleetId,
        enrollmentToken: config.enrollmentToken,
        agentId: config.agentId,
        agentSecret: config.agentSecret,
        displayName: config.displayName ?? `openclaw-${os.hostname()}`
      },
      enrolKey,
      log
    );
    if (retired && !retiredAtStart) {
      // Unloaded while enrolling (a reload mid-enrolment). The credentials are
      // saved and the newer copy, queued behind this enrolment, connects with
      // them; it also bootstraps the identity, so this copy must not race it
      // to. A later tool call here connects afresh from the saved files.
      throw new Error(`[ekho] generation ${generation} was stopped while connecting; leaving the agent to its successor`);
    }

    const client = new EkhoAgentClient({
      agentId: credentials.agentId,
      secret: credentials.secret,
      relayBaseUrl: credentials.relayBaseUrl
    });

    // Register our identity key + bootstrap-pin the operator key (best-effort).
    identityConfigDir = configDir;
    // An agent whose config already names enrolled credentials has an identity
    // somewhere; an absent file here is a lost or moved file. Minting a fresh
    // key for it needs the operator's explicit say-so (env or config), never a
    // silent default: that default is how seven phantom "Jarvis" keys came to
    // exist on the relay. A fresh enrolment (no agentId/secret yet) may mint.
    const allowCreate = shouldAllowNewIdentity(config, process.env, { hasStoredCredentials });
    try {
      if (migrationIdentityError) throw migrationIdentityError;
      identity = await registerAndBootstrapIdentity(client, {
        operatorPubkey: config.operatorPubkey,
        configDir,
        log,
        allowCreate
      });
      // TOFU (#5): pin the operator keys the relay handed us at enrollment —
      // sent since the beginning, dropped on the floor until now. Only fires
      // for a never-pinned identity (see syncPinnedOperatorKeys); explicit
      // config pins above always win.
      const enrollKeys = enrolKey ? (takeEnrolOperatorKeys(enrolKey) as EnrollOperatorKey[] | null) : null;
      if (
        enrollKeys &&
        identity &&
        syncPinnedOperatorKeys(identity, enrollKeys, credentials.fleetId || config.fleetId, log ?? console)
      ) {
        saveIdentity(configDir, identity);
        log?.info?.(`[ekho] pinned ${Object.keys(identity.pinnedOperatorKeys).length} operator key(s) from enrollment (TOFU)`);
      }
    } catch (err) {
      if (err instanceof IdentityUnavailableError) {
        // Loud and unsigned, not quiet and re-keyed. Peers that require
        // signatures will refuse this box until the operator restores the file.
        (log?.error ?? log?.warn)?.(`[ekho] identity unavailable, running UNSIGNED: ${err.message}`);
      } else {
        log?.warn?.(`[ekho] identity bootstrap failed: ${String(err)}`);
      }
    }

    connection = { client, credentials };
    log?.info?.(`[ekho] connected as ${credentials.agentId} -> ${credentials.relayBaseUrl}`);
    maybeStartHeartbeat(log, config);
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
 * The process-wide enrolment lock key, or null when this config cannot enrol
 * (explicit credentials). Hashes the token rather than holding it on globalThis.
 */
function enrolmentKey(config: EkhoPluginConfig): string | null {
  if ((config.agentId && config.agentSecret) || !config.enrollmentToken) return null;
  const token = createHash("sha256").update(config.enrollmentToken, "utf8").digest("hex");
  return `${config.relayBaseUrl}\n${config.fleetId ?? ""}\n${token}`;
}

/**
 * enrollOrLoad, coordinated across module copies (runtime-registry.ts,
 * runEnrolmentExclusive): a copy that finds no credentials waits for any other
 * copy's enrolment with the same token, then loads what it saved instead of
 * spending the token a second time. A 400 from the relay (spent token) gets
 * one bounded re-check for credentials saved meanwhile — by a copy or process
 * outside the registry — before the failure stands.
 */
async function enrollOrLoadOnce(
  args: Parameters<typeof enrollOrLoad>[0],
  key: string | null,
  log?: Logger
): Promise<EkhoCredentials> {
  const run = async () => {
    const creds = await enrollOrLoad(args);
    // This module copy's enrolment keys go where any copy can pin them: the
    // one that enrolled may be retired before it gets that far.
    const keys = takeEnrollOperatorKeys();
    if (keys && key) putEnrolOperatorKeys(key, keys);
    return creds;
  };
  try {
    return key ? await runEnrolmentExclusive(key, run) : await run();
  } catch (err) {
    if (!(err instanceof EnrollmentFailedError) || err.status !== 400) throw err;
    log?.warn?.(
      `[ekho] enrolment refused (${err.status}); re-checking for credentials saved meanwhile in ${ENROL_RECHECK_MS}ms`
    );
    await new Promise((r) => setTimeout(r, ENROL_RECHECK_MS));
    if (storedCredentialsState(args.configDir).state !== "ok") throw err;
    log?.info?.(`[ekho] found credentials saved during the refused enrolment; using them`);
    return enrollOrLoad(args);
  }
}

/**
 * Claim this agent for this module copy (see runtime-registry.ts). An older
 * copy still producing for it — a reload the host never told it about — is
 * stopped first. False, with this copy retired, when a NEWER copy already
 * holds the agent: this one is the stale generation and must start nothing.
 */
function claimRuntime(agentId: string, log?: Logger): boolean {
  if (retired) return false;
  if (claimedAgentId === agentId) return true;
  if (!claimAgentRuntime(agentId, { generation, stop: (reason) => shutdown(reason, log) })) {
    retired = true;
    log?.info?.(
      `[ekho] generation ${generation} is superseded for ${agentId}; not starting heartbeat or auto-reply`
    );
    return false;
  }
  claimedAgentId = agentId;
  return true;
}

/** Start the heartbeat exactly once per (non-retired) module copy. */
function maybeStartHeartbeat(log?: Logger, config?: EkhoPluginConfig) {
  if (heartbeatTimer || !connection) return;
  const { client, credentials } = connection;
  if (!claimRuntime(credentials.agentId, log)) return;
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
  heartbeatTimer = setInterval(beat, config?.heartbeatIntervalMs ?? 30_000);
  if (typeof heartbeatTimer === "object" && "unref" in heartbeatTimer) heartbeatTimer.unref?.();
}

/**
 * Start the auto-reply loop exactly once, sharing the single connection's
 * client. Guarded like the heartbeat timer; needs both a live connection and an
 * `api` handle (for the turn-trigger primitives) before it does anything.
 */
function maybeStartAutoReply(api: PluginApi | undefined, log?: Logger, config?: EkhoPluginConfig) {
  if (stopAutoReply || !connection || !api) return;
  if (!claimRuntime(connection.credentials.agentId, log)) return;
  // The auto-reply loop wakes the agent by spawning `openclaw agent -m`, which
  // re-loads this plugin in a one-shot child. That child sets this env var so it
  // connects for the ekho_send tool but never starts its own loop (which would
  // double-process the inbox and could recurse).
  if (process.env.EKHO_AUTOREPLY_DISABLE === "1") {
    log?.info?.("[ekho-autoreply] disabled in this process (EKHO_AUTOREPLY_DISABLE)");
    return;
  }
  const agentId = connection.credentials.agentId;
  stopAutoReply = startAutoReply({
    client: connection.client,
    api,
    selfAgentId: agentId,
    cacheContext: () => connectedInboxContext(connection!),
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
    },
    // #78: a deferred stash that will never get its ordinary turn (cap-evicted,
    // or a late turn that could not be spawned) goes to the SAME file. Those
    // messages were acked, so a record here is all that is left of them.
    onDeadLetter: (records) => {
      if (!identityConfigDir) return;
      appendDeadLetters(identityConfigDir, records);
    },
    // #111: acked work this generation lets go of at stop is left, in memory,
    // for the next generation of the SAME agent in this process, which
    // re-admits it under its own trust root (runtime-registry.ts). Bound to
    // this copy's generation; the registry only lets the current holder take.
    reloadHandoff: {
      deposit: (owner, entries) =>
        depositReloadHandoff(
          entries.map((e) => ({ ...e, owner, agentId, fromGeneration: generation, depositedAtMs: Date.now() }))
        ),
      take: (owner) => takeReloadHandoff(agentId, owner, generation),
      // What this generation served, so a later one can refuse an older
      // producer's late copy of it. Ownership only: no verdict, no payload.
      noteServed: (owner, served) => noteReloadServed(agentId, owner, generation, served),
      servedBy: (owner, kind, value) => reloadServedBy(agentId, owner, kind, value)
    }
  });
}

/**
 * Tear down the background timers (heartbeat + auto-reply loop) and retire
 * this module copy, so nothing in it starts them again. Called by the host's
 * stop signal (index.ts) and by a newer module copy taking over the agent
 * (runtime-registry.ts). Safe to call multiple times.
 *
 * Synchronously, before it returns, every acked message the loop still holds
 * is dead-lettered, except a stash a covering turn that already started is
 * delivering. The promise settles once the loop's in-flight tick has (bounded
 * by an event-loop timer, autoreply.ts STOP_DRAIN_MS); the host awaits it from
 * both unload hooks (index.ts). It does not throw, even if the host logger
 * does, and the promise never rejects.
 */
export function shutdown(reason = "shutdown", log?: Logger): Promise<void> {
  retired = true;
  const hadWork = Boolean(heartbeatTimer || stopAutoReply);
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (stopAutoReply) {
    stopDrain = stopAutoReply();
    stopAutoReply = null;
  }
  if (claimedAgentId) {
    releaseAgentRuntime(claimedAgentId, generation);
    claimedAgentId = null;
  }
  if (hadWork) {
    // The work is already secured; a throwing host logger must not cost the
    // host the drain promise it awaits.
    try {
      log?.info?.(`[ekho] generation ${generation} stopped heartbeat and auto-reply (${reason})`);
    } catch {
      /* swallowed on purpose */
    }
  }
  return stopDrain;
}

/**
 * Let this module copy produce again. register() calls it, so a host that
 * re-registers a copy it previously stopped (rather than loading a fresh one)
 * gets its heartbeat back on the next connect. Safe against reloads: if a newer
 * copy holds the agent, the claim fails and this copy retires again.
 */
export function activateRuntime(): void {
  retired = false;
}

/** Test seam: this module copy's runtime generation. */
export function runtimeGeneration(): number {
  return generation;
}
