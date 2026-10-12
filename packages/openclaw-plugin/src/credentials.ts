import fs from "node:fs";
import path from "node:path";

import { preserveUnusableFile } from "@drakon-systems/ekho-sdk/identity";

// The identity file (load, refuse-to-mint rules, atomic save) moved to the SDK
// with the MCP connector; re-exported here so callers and tests are unchanged.
export {
  ALLOW_NEW_IDENTITY_ENV,
  IdentityUnavailableError,
  identityPublicKey,
  loadOrCreateIdentity,
  saveIdentity,
  type EkhoIdentity,
  type LoadIdentityOptions,
  type OperatorKeyAdmission
} from "@drakon-systems/ekho-sdk/identity";

export interface EkhoCredentials {
  agentId: string;
  secret: string;
  relayBaseUrl: string;
  fleetId: string;
}

const CREDENTIALS_FILE = ".ekho-credentials.json";
const IDENTITY_FILE = ".ekho-identity.json";

/**
 * Thrown by enrollOrLoad instead of enrolling a NEW agent over an existing
 * enrolment whose credentials file is present but unusable. Before 4 Oct 2026
 * that file read as "nothing saved" and, with an enrollment token in config,
 * the plugin quietly became a brand-new agent with a brand-new identity.
 */
export class CredentialsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsUnavailableError";
  }
}

export type StoredCredentialsState =
  | { state: "absent" }
  | { state: "ok"; credentials: EkhoCredentials }
  | { state: "unusable"; preservedAt?: string };

/**
 * Three-way read of the saved credentials. "unusable" is a present file this
 * build cannot use — it still proves an enrolment happened here, so callers
 * must treat it as enrolled and fail closed, never as a first enrolment.
 */
export function storedCredentialsState(
  configDir: string,
  opts: { preserve?: boolean } = {}
): StoredCredentialsState {
  const filePath = path.join(configDir, CREDENTIALS_FILE);
  if (!fs.existsSync(filePath)) return { state: "absent" };
  let raw: Buffer | undefined;
  try {
    raw = fs.readFileSync(filePath);
    const parsed = JSON.parse(raw.toString("utf-8")) as Partial<EkhoCredentials> | null;
    if (parsed && typeof parsed.agentId === "string" && typeof parsed.secret === "string") {
      return { state: "ok", credentials: parsed as EkhoCredentials };
    }
  } catch {
    /* unusable */
  }
  return { state: "unusable", ...(opts.preserve ? { preservedAt: preserveUnusableFile(filePath, raw) } : {}) };
}

/** Null for absent OR unusable. Prefer storedCredentialsState where the
 *  difference matters (it always does before enrolling or minting). */
export function loadCredentials(configDir: string): EkhoCredentials | null {
  const stored = storedCredentialsState(configDir);
  return stored.state === "ok" ? stored.credentials : null;
}

/** Same atomic temp-then-rename, owner-only write as saveIdentity: the file
 *  holds the agent secret. */
export function saveCredentials(configDir: string, credentials: EkhoCredentials) {
  fs.mkdirSync(configDir, { recursive: true });
  const filePath = path.join(configDir, CREDENTIALS_FILE);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
}

/** Operator keys the relay handed us at enrollment — the trust bootstrap the
 *  relay has always sent and this plugin used to drop on the floor (#5).
 *  Consumed once by registerAndBootstrapIdentity right after enrollment. */
export interface EnrollOperatorKey {
  key_id?: string;
  public_key?: string;
  endorsed_by_key_id?: string | null;
  endorsement_sig?: string | null;
}
let lastEnrollOperatorKeys: EnrollOperatorKey[] | null = null;
export function takeEnrollOperatorKeys(): EnrollOperatorKey[] | null {
  const keys = lastEnrollOperatorKeys;
  lastEnrollOperatorKeys = null;
  return keys;
}

/**
 * Total deadline for the enrol request, response headers AND body. Enrolment
 * runs under the process-wide enrolment lock (runtime-registry.ts), so a
 * request that never answers would hold every same-key successor forever.
 * Aborted, this copy saves nothing: a queued successor then enrols itself, and
 * if the abandoned request did reach the relay, the single-use token is spent
 * and the successor gets the 400 path (one re-check, then a visible failure),
 * never a second identity.
 */
export const ENROLL_TIMEOUT_MS = 30_000;

/** The relay refused the enrolment (a 400 for a spent or expired token). */
export class EnrollmentFailedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "EnrollmentFailedError";
  }
}

export async function enrollOrLoad(config: {
  configDir: string;
  relayBaseUrl: string;
  fleetId?: string;
  enrollmentToken?: string;
  agentId?: string;
  agentSecret?: string;
  displayName: string;
}): Promise<EkhoCredentials> {
  // 1. Explicit credentials in config
  if (config.agentId && config.agentSecret) {
    const creds: EkhoCredentials = {
      agentId: config.agentId,
      secret: config.agentSecret,
      relayBaseUrl: config.relayBaseUrl,
      fleetId: config.fleetId ?? ""
    };
    saveCredentials(config.configDir, creds);
    return creds;
  }

  // 2. Saved credentials from previous enrollment. A present-but-unusable
  //    file is still an enrolment: refuse, keep the bytes, and never fall
  //    through to the token path — that path mints a NEW agent and identity.
  const stored = storedCredentialsState(config.configDir, { preserve: true });
  if (stored.state === "ok") return stored.credentials;
  if (stored.state === "unusable") {
    throw new CredentialsUnavailableError(
      `[ekho-adapter] saved credentials at ${path.join(config.configDir, CREDENTIALS_FILE)} are present but unusable; ` +
        `refusing to enrol a new agent over them` +
        (stored.preservedAt ? ` (bytes preserved at ${stored.preservedAt})` : "") +
        `. Restore the file from a backup, or remove it to enrol again on purpose.`
    );
  }

  // 3. Enroll with token
  if (!config.enrollmentToken || !config.fleetId) {
    throw new Error("[ekho-adapter] No credentials and no enrollment token configured. Set agentId+agentSecret or fleetId+enrollmentToken.");
  }

  const abort = new AbortController();
  const deadline = setTimeout(
    () => abort.abort(new Error(`[ekho-adapter] Enrollment request timed out after ${ENROLL_TIMEOUT_MS}ms`)),
    ENROLL_TIMEOUT_MS
  );
  let body: { agent_id: string; secret: string; operator_keys?: EnrollOperatorKey[] };
  try {
    const res = await fetch(`${config.relayBaseUrl}/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fleet_id: config.fleetId,
        token: config.enrollmentToken,
        display_name: config.displayName,
        runtime: "openclaw"
      }),
      // Also bounds the body reads below: an abort fails a pending read.
      signal: abort.signal
    });

    if (!res.ok) {
      const text = await res.text();
      throw new EnrollmentFailedError(`[ekho-adapter] Enrollment failed: ${res.status} ${text}`, res.status);
    }

    body = await res.json() as typeof body;
  } finally {
    clearTimeout(deadline);
  }
  lastEnrollOperatorKeys = Array.isArray(body.operator_keys) ? body.operator_keys : null;
  const creds: EkhoCredentials = {
    agentId: body.agent_id,
    secret: body.secret,
    relayBaseUrl: config.relayBaseUrl,
    fleetId: config.fleetId
  };
  saveCredentials(config.configDir, creds);
  return creds;
}
