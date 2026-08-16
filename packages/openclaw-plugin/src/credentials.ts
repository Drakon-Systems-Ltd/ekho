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

export function loadOrCreateIdentity(configDir: string): EkhoIdentity {
  const filePath = path.join(configDir, IDENTITY_FILE);
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<EkhoIdentity>;
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
      /* fall through and regenerate */
    }
  }
  const identity: EkhoIdentity = {
    seedHex: crypto.randomBytes(32).toString("hex"),
    pinnedOperatorKeys: {}
  };
  saveIdentity(configDir, identity);
  return identity;
}

export function saveIdentity(configDir: string, identity: EkhoIdentity) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, IDENTITY_FILE), JSON.stringify(identity, null, 2), {
    mode: 0o600
  });
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
