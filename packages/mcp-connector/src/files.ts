// Atomic, owner-only state files. Every durable file the connector keeps
// (credentials, queue, OAuth state) goes through writeAtomic: a sibling temp
// file renamed over the real one, so no reader ever sees a torn write and a
// crash mid-write leaves the previous version intact. The identity file has
// its own equivalent in the SDK (saveIdentity).

import fs from "node:fs";
import path from "node:path";

export function writeAtomic(filePath: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
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

export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeAtomic(filePath, JSON.stringify(value, null, 2) + "\n");
}

/** Parse a JSON file; `undefined` when absent; throws when present but unusable. */
export function readJsonIfPresent<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}
