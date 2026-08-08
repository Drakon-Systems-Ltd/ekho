// Dead-letter store for signed inbound messages that FAILED verification.
//
// The loop acks every delivered batch wholesale (at-most-once consumption), so
// a message rejected by the signature gate has no redelivery path: without a
// record here it is acked, binned, and unrecoverable — and the sender believes
// it was received. That silent bin is exactly how the fleet's unendorsed
// operator-key drops stayed undiagnosed (Aug 2026): patched boxes acked and
// discarded every signed message from the unendorsed agent with no trace.
// Every reject is appended as one JSONL line beside the identity file; the
// loop separately logs the verdict reason at warn.

import fs from "node:fs";
import path from "node:path";

export const DEAD_LETTER_FILE = ".ekho-dead-letter.jsonl";

// One-step rotation keeps the file bounded without ever dropping the freshest
// evidence: the current file always holds the most recent rejects.
const MAX_BYTES = 5 * 1024 * 1024;

export interface DeadLetterRecord {
  rejected_at: string;
  reason: string | null;
  kind: string;
  key_id: string | null;
  message: unknown;
}

export function appendDeadLetters(configDir: string, records: DeadLetterRecord[]): void {
  if (records.length === 0) return;
  const filePath = path.join(configDir, DEAD_LETTER_FILE);
  fs.mkdirSync(configDir, { recursive: true });
  try {
    if (fs.statSync(filePath).size > MAX_BYTES) fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    /* no existing file — nothing to rotate */
  }
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(filePath, lines, { mode: 0o600 });
}
