import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Plugin-side attachment helpers. Mirrors the relay's allowlist, size cap, and
 * filename sanitization so the plugin rejects bad inputs locally with a clear
 * tool-result error before hitting the wire (the relay is still authoritative).
 *
 * Kept dependency-free so it bundles cleanly with esbuild (openclaw external).
 */

// 25 MiB — matches the relay default (config.attachmentMaxBytes).
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
// Per-message count cap — matches the relay default (config.attachmentMaxPerMessage).
export const ATTACHMENT_MAX_PER_MESSAGE = 10;

/** ext (no dot, lowercased) -> mime. Mirrors the relay's ATTACHMENT_MIME_ALLOWLIST. */
export const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json"
};

// Control chars (incl NUL) to strip from filenames: U+0000..U+001F and U+007F.
// Built via RegExp/fromCharCode so the source file stays pure-ASCII (no literal
// control bytes), while matching the same range as the relay's sanitizeFilename.
const CONTROL_CHARS = new RegExp(
  "[" + String.fromCharCode(0) + "-" + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + "]",
  "g"
);

/** Resolve a local file path's extension to an allowed mime, or undefined. */
export function mimeForPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  return EXT_TO_MIME[ext];
}

/**
 * Strip path separators, control chars, and leading dots; collapse whitespace;
 * cap length. Returns a safe basename that can never traverse directories or
 * smuggle a second extension via NUL/CR/LF. Falls back to "file" if empty.
 * Mirrors the relay's sanitizeFilename.
 */
export function sanitizeFilename(raw: string): string {
  const base = path.basename(String(raw ?? "")); // drops any dir component
  const cleaned = base
    .replace(CONTROL_CHARS, "")                     // control chars incl NUL
    .replace(/[/\\]/g, "")                          // belt-and-braces separators
    .replace(/^\.+/, "")                            // no leading dots (".." / dotfiles)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return cleaned || "file";
}

/** Absolute scoped dir where ekho_inbox writes downloaded attachment bytes. */
export function attachmentsDownloadDir(): string {
  return path.join(os.homedir(), ".openclaw", "extensions", "ekho-adapter", "attachments");
}

/**
 * Local on-disk path for a downloaded attachment. Prefixes the SERVER-generated
 * id so two attachments with the same display name never collide, and so the
 * (sanitized) user filename can never traverse out of the scoped dir.
 */
export function attachmentLocalPath(id: string, filename: string): string {
  const safeId = path.basename(String(id ?? "")) || "att";
  const safeName = sanitizeFilename(filename);
  return path.join(attachmentsDownloadDir(), `${safeId}__${safeName}`);
}

/**
 * Read a local file for upload: validates the extension maps to an allowed mime
 * and the byte length is within the cap. Throws a clear Error on any violation
 * (the tool surfaces it as a tool-result error). Returns the decoded bytes,
 * resolved mime, and basename.
 */
export function readUploadFile(filePath: string): { bytes: Buffer; mime: string; filename: string } {
  const mime = mimeForPath(filePath);
  if (!mime) {
    throw new Error(
      `attachment "${path.basename(filePath)}" has an unsupported type — allowed: ${Object.keys(EXT_TO_MIME).join(", ")}`
    );
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (err) {
    throw new Error(`could not read attachment "${filePath}": ${String((err as Error)?.message ?? err)}`);
  }
  if (bytes.length > ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `attachment "${path.basename(filePath)}" is ${bytes.length} bytes, over the ${ATTACHMENT_MAX_BYTES}-byte cap`
    );
  }
  return { bytes, mime, filename: path.basename(filePath) };
}
