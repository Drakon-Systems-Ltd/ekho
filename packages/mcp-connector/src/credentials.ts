// Relay credentials for this connector (agent id + HMAC secret). Same rules
// the OpenClaw plugin applies since #96: a present-but-unusable file is still
// an enrolment, so it is preserved and refused, never enrolled over.

import fs from "node:fs";
import path from "node:path";
import { preserveUnusableFile } from "@drakon-systems/ekho-sdk/identity";
import { writeJsonAtomic } from "./files.js";

export const CREDENTIALS_FILE = ".ekho-credentials.json";

export interface StoredCredentials {
  agentId: string;
  secret: string;
  relayBaseUrl: string;
  fleetId: string;
}

export class CredentialsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsUnavailableError";
  }
}

export class EnrollmentFailedError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "EnrollmentFailedError";
  }
}

export type CredentialsState =
  | { state: "absent" }
  | { state: "ok"; credentials: StoredCredentials }
  | { state: "unusable"; preservedAt?: string };

export function credentialsState(stateDir: string): CredentialsState {
  const filePath = path.join(stateDir, CREDENTIALS_FILE);
  if (!fs.existsSync(filePath)) return { state: "absent" };
  let raw: Buffer | undefined;
  try {
    raw = fs.readFileSync(filePath);
    const parsed = JSON.parse(raw.toString("utf8")) as Partial<StoredCredentials> | null;
    if (
      parsed &&
      typeof parsed.agentId === "string" &&
      typeof parsed.secret === "string" &&
      typeof parsed.fleetId === "string" &&
      typeof parsed.relayBaseUrl === "string"
    ) {
      return { state: "ok", credentials: parsed as StoredCredentials };
    }
  } catch {
    /* unusable */
  }
  return { state: "unusable", preservedAt: preserveUnusableFile(filePath, raw) };
}

export function saveCredentials(stateDir: string, credentials: StoredCredentials): void {
  writeJsonAtomic(path.join(stateDir, CREDENTIALS_FILE), credentials);
}

export interface EnrollOperatorKey {
  key_id?: string;
  public_key?: string;
  revoked?: boolean;
  revoked_at?: string | null;
  revocation_sig?: string | null;
  endorsed_by_key_id?: string | null;
  endorsement_sig?: string | null;
}

export const ENROLL_TIMEOUT_MS = 30_000;

/** Enrol a NEW agent with a one-time fleet token. Registers the identity
 *  public key in the same request (the relay accepts it since enrollment-time
 *  registration landed); the caller still re-posts it to /v1/identity-key,
 *  which is idempotent, so an older relay is covered too. */
export async function enroll(opts: {
  relayBaseUrl: string;
  fleetId: string;
  enrollmentToken: string;
  displayName: string;
  identityPublicKey: string;
  fetchImpl?: typeof fetch;
}): Promise<{ credentials: StoredCredentials; operatorKeys: EnrollOperatorKey[] }> {
  const f = opts.fetchImpl ?? fetch;
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(new Error("enrolment timed out")), ENROLL_TIMEOUT_MS);
  try {
    const res = await f(`${opts.relayBaseUrl}/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fleet_id: opts.fleetId,
        token: opts.enrollmentToken,
        display_name: opts.displayName,
        runtime: "custom",
        identity_public_key: opts.identityPublicKey
      }),
      signal: abort.signal
    });
    if (!res.ok) {
      throw new EnrollmentFailedError(`enrolment failed: ${res.status} ${await res.text()}`, res.status);
    }
    const body = (await res.json()) as { agent_id: string; secret: string; operator_keys?: EnrollOperatorKey[] };
    return {
      credentials: { agentId: body.agent_id, secret: body.secret, relayBaseUrl: opts.relayBaseUrl, fleetId: opts.fleetId },
      operatorKeys: Array.isArray(body.operator_keys) ? body.operator_keys : []
    };
  } finally {
    clearTimeout(deadline);
  }
}
