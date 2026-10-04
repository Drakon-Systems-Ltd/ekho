import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { publicKeyB64urlFromSeed } from "./identity.js";

export interface EkhoCredentials {
  agentId: string;
  secret: string;
  relayBaseUrl: string;
  fleetId: string;
}

const CREDENTIALS_FILE = ".ekho-credentials.json";
const IDENTITY_FILE = ".ekho-identity.json";

/** Why a pinned operator key is trusted on THIS box (#26). Written at the moment
 *  the gate admitted the key, so the question "why is this key trusted here?"
 *  has an offline answer — no relay round trip, and nothing to re-ask the relay
 *  for (which is exactly the party we don't trust). For a chain admission the
 *  endorsement signature is kept verbatim, so the endorsement can be re-verified
 *  from disk against the endorser's pinned public key. */
export interface OperatorKeyAdmission {
  admitted_by: "tofu" | "chain";
  /** Chain only: the pinned key whose endorsement admitted this one. */
  endorsed_by_key_id?: string;
  /** Chain only: the endorsement signature this box actually verified. */
  endorsement_sig?: string;
  admitted_at: string;
}

/** The agent's own Ed25519 identity (private seed) + the operator keys it pins. */
export interface EkhoIdentity {
  seedHex: string;
  pinnedOperatorKeys: Record<string, string>;
  /** Set once, when the empty pin set trust-on-first-use adopted the relay's
   *  operator keys (#5). Latched forever so a later emptied pin set can never
   *  be re-seeded by whoever controls the relay at that moment. */
  tofuAt?: string;
  /** key_id -> ISO timestamp we first saw the relay report it revoked (#14).
   *  A tombstone ledger, not a cache: unpinning a revoked key is worthless on
   *  its own because the config seed, TOFU and endorsement chaining all re-add
   *  it on the next wake. Every add path consults this, so revocation sticks. */
  revokedOperatorKeys?: Record<string, string>;
  /** key_id -> the evidence that admitted it (#26). */
  operatorKeyAdmissions?: Record<string, OperatorKeyAdmission>;
}

/**
 * Thrown instead of minting. Before 4 Oct 2026 an identity file that was
 * present but unparseable, or absent on a box whose config already names an
 * enrolled agent, silently produced a NEW random seed and registered it with
 * the relay. Seven live "Jarvis" identity keys with no private half anywhere
 * were found that way, each later endorsed by the operator in good faith. A
 * key that exists only because a read failed is a forged identity, not a
 * recovery; the caller must stop and say so.
 */
export class IdentityUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: "unreadable" | "missing"
  ) {
    super(message);
    this.name = "IdentityUnavailableError";
  }
}

/** Set to "1" to let an already-enrolled agent mint a brand-new identity key. */
export const ALLOW_NEW_IDENTITY_ENV = "EKHO_ALLOW_NEW_IDENTITY";

export interface LoadIdentityOptions {
  /**
   * Whether an ABSENT file may be answered with a freshly minted identity.
   * Default true (first enrolment). Pass false for an agent whose config already
   * carries enrolled credentials: its identity must already exist somewhere,
   * so an absent file is a lost/moved file, not a new agent.
   */
  allowCreate?: boolean;
}

export function loadOrCreateIdentity(configDir: string, opts: LoadIdentityOptions = {}): EkhoIdentity {
  const filePath = path.join(configDir, IDENTITY_FILE);
  if (fs.existsSync(filePath)) {
    let raw: string | undefined;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as Partial<EkhoIdentity>;
      if (data?.seedHex) {
        // Spread the file FIRST: a field this build doesn't know about (written
        // by a newer plugin, or by the other runtime sharing the config dir)
        // survives the load/save round trip instead of being silently dropped.
        return {
          ...data,
          seedHex: String(data.seedHex),
          pinnedOperatorKeys: (data.pinnedOperatorKeys as Record<string, string>) ?? {},
          ...(data.tofuAt ? { tofuAt: String(data.tofuAt) } : {}),
          ...(data.revokedOperatorKeys
            ? { revokedOperatorKeys: data.revokedOperatorKeys as Record<string, string> }
            : {}),
          ...(data.operatorKeyAdmissions
            ? { operatorKeyAdmissions: data.operatorKeyAdmissions as Record<string, OperatorKeyAdmission> }
            : {})
        };
      }
    } catch {
      /* present but unusable: handled below, never regenerated over */
    }
    // The file is there but this build cannot use it (unreadable, not JSON,
    // or no seed). Keep the bytes for forensics and refuse. Overwriting them
    // with a new seed would both destroy the evidence and mint a second live
    // identity for this agent on the relay.
    const preserved = preserveUnusableIdentity(filePath, raw);
    throw new IdentityUnavailableError(
      `[ekho] identity file ${filePath} is present but unusable; refusing to mint a replacement key` +
        (preserved ? ` (bytes preserved at ${preserved})` : "") +
        `. Restore the file from a backup, or remove it and set ${ALLOW_NEW_IDENTITY_ENV}=1 to enrol a new key on purpose.`,
      "unreadable"
    );
  }
  if (opts.allowCreate === false) {
    throw new IdentityUnavailableError(
      `[ekho] no identity file at ${filePath} but this agent is already enrolled; refusing to mint a new key. ` +
        `Restore the file from a backup (the relay already holds this agent's key), or set ${ALLOW_NEW_IDENTITY_ENV}=1 to re-key on purpose.`,
      "missing"
    );
  }
  const identity: EkhoIdentity = {
    seedHex: crypto.randomBytes(32).toString("hex"),
    pinnedOperatorKeys: {}
  };
  saveIdentity(configDir, identity);
  return identity;
}

function preserveUnusableIdentity(filePath: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const target = `${filePath}.unusable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    fs.writeFileSync(target, raw, { mode: 0o600 });
    return target;
  } catch {
    return undefined; // best effort; the refusal above is what matters
  }
}

/**
 * Atomic: write a sibling temp file and rename it over the real one, so no
 * reader (another plugin instance, a CLI run, the other runtime sharing this
 * dir) can ever observe a truncated identity file mid-write.
 */
export function saveIdentity(configDir: string, identity: EkhoIdentity) {
  fs.mkdirSync(configDir, { recursive: true });
  const filePath = path.join(configDir, IDENTITY_FILE);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 });
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

export function identityPublicKey(identity: EkhoIdentity): string {
  return publicKeyB64urlFromSeed(new Uint8Array(Buffer.from(identity.seedHex, "hex")));
}

export function loadCredentials(configDir: string): EkhoCredentials | null {
  const filePath = path.join(configDir, CREDENTIALS_FILE);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as EkhoCredentials;
  } catch {
    return null;
  }
}

export function saveCredentials(configDir: string, credentials: EkhoCredentials) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, CREDENTIALS_FILE), JSON.stringify(credentials, null, 2));
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

  // 2. Saved credentials from previous enrollment
  const saved = loadCredentials(config.configDir);
  if (saved) return saved;

  // 3. Enroll with token
  if (!config.enrollmentToken || !config.fleetId) {
    throw new Error("[ekho-adapter] No credentials and no enrollment token configured. Set agentId+agentSecret or fleetId+enrollmentToken.");
  }

  const res = await fetch(`${config.relayBaseUrl}/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fleet_id: config.fleetId,
      token: config.enrollmentToken,
      display_name: config.displayName,
      runtime: "openclaw"
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[ekho-adapter] Enrollment failed: ${res.status} ${text}`);
  }

  const body = await res.json() as { agent_id: string; secret: string; operator_keys?: EnrollOperatorKey[] };
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
