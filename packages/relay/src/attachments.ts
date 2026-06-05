import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

export const ATTACHMENT_MIME_ALLOWLIST = {
  "image/png":        { ext: "png",  image: true },
  "image/jpeg":       { ext: "jpg",  image: true },
  "image/gif":        { ext: "gif",  image: true },
  "image/webp":       { ext: "webp", image: true },
  "application/pdf":  { ext: "pdf",  image: false },
  "text/plain":       { ext: "txt",  image: false },
  "text/markdown":    { ext: "md",   image: false },
  "text/csv":         { ext: "csv",  image: false },
  "application/json": { ext: "json", image: false }
} as const;

export type AllowedMime = keyof typeof ATTACHMENT_MIME_ALLOWLIST;

export function isAllowedMime(mime: string): mime is AllowedMime {
  return Object.prototype.hasOwnProperty.call(ATTACHMENT_MIME_ALLOWLIST, mime);
}

export function isImageMime(mime: AllowedMime): boolean {
  return ATTACHMENT_MIME_ALLOWLIST[mime].image;
}

/**
 * Strip path separators, control chars, and leading dots; collapse whitespace;
 * cap length. Returns a safe basename that can never traverse directories or
 * smuggle a second extension via NUL/CR/LF. Falls back to "file" if empty.
 */
export function sanitizeFilename(raw: string): string {
  const base = path.basename(String(raw ?? "")); // drops any dir component
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")          // control chars incl NUL
    .replace(/[/\\]/g, "")                          // belt-and-braces separators
    .replace(/^\.+/, "")                            // no leading dots (".." / dotfiles)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return cleaned || "file";
}

/**
 * Magic-byte sniff for the image types. Confirms the DECLARED image mime matches
 * the actual bytes (defeats "rename evil.html to png" + content-sniffing exec).
 * Non-image (doc) types are not byte-sniffed here — they are served non-inline
 * with Content-Disposition: attachment, so a mismatched doc can't execute.
 * Returns true if the declared mime is consistent with the bytes.
 */
export function sniffImageMatches(mime: AllowedMime, bytes: Buffer): boolean {
  if (!isImageMime(mime)) return true; // docs: not sniffed, see note above
  const b = bytes;
  switch (mime) {
    case "image/png":
      return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
        && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
    case "image/jpeg":
      return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/gif":
      return b.length >= 6 && b.slice(0, 6).toString("ascii").match(/^GIF8[79]a$/) !== null;
    case "image/webp":
      return b.length >= 12 && b.slice(0, 4).toString("ascii") === "RIFF"
        && b.slice(8, 12).toString("ascii") === "WEBP";
    default:
      return false;
  }
}

export function attachmentStoragePath(fleetId: string, attachmentId: string): string {
  // fleetId/attachmentId are server-generated id() values (prefix_hex) — no user
  // input — but pass through basename defensively.
  return path.join(config.attachmentsDir, path.basename(fleetId), path.basename(attachmentId));
}

export function writeAttachmentBytes(fleetId: string, attachmentId: string, bytes: Buffer): string {
  const full = attachmentStoragePath(fleetId, attachmentId);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes, { mode: 0o600 }); // owner-only; not world-readable
  return full;
}

/** Decode declared base64 → bytes. Throws on malformed input (route → 400). */
export function decodeBase64Strict(dataBase64: string): Buffer {
  if (typeof dataBase64 !== "string" || dataBase64.length === 0) {
    throw new Error("dataBase64 missing or empty");
  }
  const buf = Buffer.from(dataBase64, "base64");
  // Buffer.from is lenient; re-encode and compare lengths to reject junk that
  // silently truncates. (Strip whitespace before comparing.)
  const normalized = dataBase64.replace(/\s+/g, "");
  if (buf.length === 0 || Math.abs(buf.toString("base64").length - normalized.length) > 4) {
    throw new Error("dataBase64 is not valid base64");
  }
  return buf;
}
