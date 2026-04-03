import crypto from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hashSecret(secret: string): string {
  return sha256(secret);
}

export function sign(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function addSeconds(isoDate: string, seconds: number): string {
  return new Date(new Date(isoDate).getTime() + seconds * 1000).toISOString();
}
