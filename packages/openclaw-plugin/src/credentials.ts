import fs from "node:fs";
import path from "node:path";

export interface EkhoCredentials {
  agentId: string;
  secret: string;
  relayBaseUrl: string;
  fleetId: string;
}

const CREDENTIALS_FILE = ".ekho-credentials.json";

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

  const body = await res.json() as { agent_id: string; secret: string };
  const creds: EkhoCredentials = {
    agentId: body.agent_id,
    secret: body.secret,
    relayBaseUrl: config.relayBaseUrl,
    fleetId: config.fleetId
  };
  saveCredentials(config.configDir, creds);
  return creds;
}
