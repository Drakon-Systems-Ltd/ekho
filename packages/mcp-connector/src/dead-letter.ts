// Dead-letter store for inbound messages the connector acked but will not hand
// to the MCP client — a signed message that failed verification, or in
// `require` mode anything unverified. Same JSONL-beside-the-identity-file
// shape and one-step rotation as the OpenClaw plugin, so an operator's
// `grep` works the same on both.

import fs from "node:fs";
import path from "node:path";

export const DEAD_LETTER_FILE = ".ekho-dead-letter.jsonl";
const MAX_BYTES = 5 * 1024 * 1024;

export interface DeadLetterRecord {
  rejected_at: string;
  reason: string | null;
  kind: string;
  key_id: string | null;
  message: unknown;
}

export function appendDeadLetters(stateDir: string, records: DeadLetterRecord[]): void {
  if (records.length === 0) return;
  const filePath = path.join(stateDir, DEAD_LETTER_FILE);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    if (fs.statSync(filePath).size > MAX_BYTES) fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    /* no existing file — nothing to rotate */
  }
  fs.appendFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
}
