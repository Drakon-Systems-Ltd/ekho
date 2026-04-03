import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

export interface EkhoLicense {
  tier: "oss" | "pro";
  org: string;
  max_fleets: number;
  features: string[];
  issued_at: string;
  expires_at: string;
}

export interface BeforeMessageContext {
  fleetId: string;
  senderAgentId: string;
  recipientId: string | null;
  messageType: string;
}

export interface FleetCreateContext {
  fleetId: string;
  fleetName: string;
}

export interface OverviewContext {
  fleetId: string;
  overview: Record<string, unknown>;
}

export interface EkhoExtension {
  name: string;
  onBeforeMessage?(ctx: BeforeMessageContext): Promise<void>;
  onFleetCreate?(ctx: FleetCreateContext): Promise<void>;
  onOverviewRequest?(ctx: OverviewContext): Promise<Record<string, unknown>>;
}

const OSS_LICENSE: EkhoLicense = {
  tier: "oss",
  org: "community",
  max_fleets: 1,
  features: [],
  issued_at: new Date().toISOString(),
  expires_at: "2099-12-31T23:59:59.000Z"
};

const extensions: EkhoExtension[] = [];
let loadedLicense: EkhoLicense = OSS_LICENSE;

function base64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function verifyAndDecodeLicenseJwt(token: string): EkhoLicense {
  const parts = token.trim().split(".");
  if (parts.length !== 3) throw new Error("invalid license format");

  const [headerB64, payloadB64, signatureB64] = parts;
  const publicKeyPem = fs.readFileSync(path.join(__dirname, "license-public-key.pem"), "utf-8");

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  const valid = verifier.verify(publicKeyPem, base64urlDecode(signatureB64));
  if (!valid) throw new Error("invalid license signature");

  const payload = JSON.parse(base64urlDecode(payloadB64).toString("utf-8")) as Record<string, unknown>;

  if (typeof payload.expires_at === "string" && new Date(payload.expires_at) < new Date()) {
    throw new Error("license expired");
  }

  return {
    tier: (payload.tier as "oss" | "pro") ?? "oss",
    org: (payload.org as string) ?? "unknown",
    max_fleets: (payload.max_fleets as number) ?? 1,
    features: (payload.features as string[]) ?? [],
    issued_at: (payload.issued_at as string) ?? new Date().toISOString(),
    expires_at: (payload.expires_at as string) ?? "2099-12-31T23:59:59.000Z"
  };
}

export function loadLicense(): EkhoLicense {
  // Read env directly (not from cached config) so tests can change env between calls
  const envKey = process.env.EKHO_LICENSE_KEY;
  const envPath = process.env.EKHO_LICENSE_PATH;

  // 1. Check env var
  if (envKey) {
    try {
      loadedLicense = verifyAndDecodeLicenseJwt(envKey);
      return loadedLicense;
    } catch (err) {
      console.warn(`[license] failed to verify EKHO_LICENSE_KEY: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 2. Check license file
  const licensePath = envPath ?? path.join(__dirname, "..", "ekho.license");
  if (fs.existsSync(licensePath)) {
    try {
      const token = fs.readFileSync(licensePath, "utf-8");
      loadedLicense = verifyAndDecodeLicenseJwt(token);
      return loadedLicense;
    } catch (err) {
      console.warn(`[license] failed to verify license file: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 3. OSS fallback
  loadedLicense = OSS_LICENSE;
  return loadedLicense;
}

export function getLoadedLicense(): EkhoLicense {
  return loadedLicense;
}

export function assertFleetCreationAllowed(currentFleetCount: number) {
  if (currentFleetCount >= loadedLicense.max_fleets && loadedLicense.tier === "oss") {
    throw new Error(`OSS license allows ${loadedLicense.max_fleets} fleet(s). Upgrade to Pro for multi-fleet support.`);
  }
}

export function registerExtension(ext: EkhoExtension) {
  extensions.push(ext);
}

export function getExtensions(): readonly EkhoExtension[] {
  return Object.freeze([...extensions]);
}
